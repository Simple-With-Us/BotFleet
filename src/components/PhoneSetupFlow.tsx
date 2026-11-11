import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Check,
  Cloud,
  Loader2,
  Mail,
  QrCode,
  ShieldCheck,
  Smartphone,
  Wifi,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  companionPairingLink,
  companionPairingRoute,
  companionPairingRoutePin,
  companionPairingRoutePinAvailable,
  type CompanionEndpoint,
  type CompanionPairingRoutePin,
  type CompanionPairingRouteMode,
} from "../lib/companion-pairing";
import {
  PHONE_SETUP_PROVISIONING_TIMEOUT_MS,
  claimPhonePairingAttempt,
  closePhonePairingIfOwned,
  completePhonePairingAttempt,
  companionPairingMode,
  companionPairingOpenFailure,
  companionStartFailure,
  derivePhoneSetupPhase,
  initialPhoneSetupFlowState,
  keepPhonePairingIfCurrent,
  invalidatePhonePairingAttempt,
  newlyPairedDeviceForFlow,
  normalizePhoneSetupActionError,
  phonePairingGate,
  phoneSetupBaseline,
  phoneSetupReducer,
  queuePhonePairingAttempt,
  releasePhonePairingAttempt,
  shouldArmPhoneSetupProvisioningTimeout,
  startNonOverlappingPhoneSetupPoll,
  type PhoneSetupPhase,
  type PhonePairingAttemptLock,
  type PhonePairingAttemptQueue,
} from "../lib/phone-setup";
import type { CompanionAccountState } from "../types/ogb";
import { ConnectionDetail } from "./ConnectionDetail";

export interface PhoneDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  cloudDesktopAccess: boolean;
}

export interface CompanionState {
  enabled: boolean;
  keepAwake: boolean;
  port: number;
  devices: PhoneDevice[];
  connectedDeviceIds?: string[];
  pairing: { code: string; token: string; expiresAt: number } | null;
  addresses?: string[];
  tailscale?: string;
  tailnetName?: string;
  lan?: string | null;
  hosts?: string[];
  endpoints?: CompanionEndpoint[];
  discovery?: { advertising: boolean; name: string };
  error?: string;
}

export type CompanionBridge = {
  state: () => Promise<CompanionState>;
  start: () => Promise<CompanionState>;
  stop: () => Promise<CompanionState>;
  keepAwake: (enabled: boolean) => Promise<CompanionState>;
  pairing: (open: boolean, expectedToken?: string) => Promise<CompanionState>;
  cloudDesktop: (deviceId: string, allowed: boolean) => Promise<CompanionState>;
  revoke: (deviceId: string) => Promise<CompanionState>;
};

type AccountBridge = NonNullable<NonNullable<Window["ogb"]>["companionAccount"]>;
type StateBridge<T> = { state: () => Promise<T> };
const DIRECT_PAIRING_UNAVAILABLE =
  "Direct Wi-Fi pairing isn’t available on this computer right now.  Connect this computer to Wi-Fi, then try again.";
const TAILSCALE_PAIRING_UNAVAILABLE =
  "Tailscale pairing isn’t available right now.  Make sure Tailscale is connected and MagicDNS is on.";
const PROTECTED_PAIRING_UNAVAILABLE =
  "The HTTPS pairing route became unavailable.  Check secure access, then create a new code.";

interface OwnedCompanionPairingRoutePin extends CompanionPairingRoutePin {
  generation: number;
  token: string;
}

interface PhonePairingRequest {
  routeMode: CompanionPairingRouteMode;
  accountOverride?: CompanionAccountState | null;
  generation: number;
}

export const companionBridge = (): CompanionBridge | null =>
  // SAFETY: the preload owns this narrow bridge; browser builds are guarded by the optional lookup.
  (globalThis as { ogb?: { companion?: CompanionBridge } }).ogb?.companion ?? null;

export const companionAccountBridge = (): AccountBridge | null =>
  // SAFETY: Electron exposes only these account operations and never sends credentials to the renderer.
  (globalThis as { ogb?: { companionAccount?: AccountBridge } }).ogb?.companionAccount ?? null;

export const loadCompanionBridgeState = async (
  companion: StateBridge<CompanionState> | null,
  remote: StateBridge<CompanionAccountState> | null,
): Promise<{ companion: CompanionState | null; account: CompanionAccountState | null }> => {
  const [companionResult, accountResult] = await Promise.allSettled([
    companion ? Promise.resolve().then(() => companion.state()) : Promise.resolve(null),
    remote ? Promise.resolve().then(() => remote.state()) : Promise.resolve(null),
  ]);
  return {
    companion: companionResult.status === "fulfilled" ? companionResult.value : null,
    account: accountResult.status === "fulfilled" ? accountResult.value : null,
  };
};

export interface CompanionStateMutationEpoch {
  current: number;
}

/** Polls capture the epoch before reading. A mutation advances it both before
 * and after the IPC call, invalidating snapshots taken before or during that
 * mutation while leaving the independently loaded account result usable. */
export const mutateCompanionBridgeState = async <State,>(
  epoch: CompanionStateMutationEpoch,
  mutate: () => Promise<State>,
): Promise<State> => {
  epoch.current += 1;
  try {
    return await mutate();
  } finally {
    epoch.current += 1;
  }
};

export const companionStateRefreshIsCurrent = (
  epoch: CompanionStateMutationEpoch,
  refreshEpoch: number,
): boolean => epoch.current === refreshEpoch;

export const shouldHydrateCompanionEmail = (
  userEdited: boolean,
  account: CompanionAccountState,
): boolean => !userEdited && Boolean(account.email);

export const companionAccountActionError = (
  account: CompanionAccountState | null,
  actionError: string | null,
): string | null => {
  if (actionError) return actionError;
  return account?.status === "signed-out" ? account.message ?? null : null;
};

export const phonePairingManualCodeMode = (
  pairingOpen: boolean,
  pairingLink: string | null,
): "details" | "direct" | "hidden" => {
  if (!pairingOpen) return "hidden";
  return pairingLink ? "details" : "direct";
};

export interface PhoneSetupController {
  state: CompanionState | null;
  account: CompanionAccountState | null;
  phase: PhoneSetupPhase;
  email: string;
  code: string;
  codeSent: boolean;
  busy: boolean;
  accountBusy: boolean;
  error: string | null;
  accountError: string | null;
  pairingLink: string | null;
  secondsLeft: number;
  address: string | undefined;
  pairingPort: number;
  hostedReady: boolean;
  localFallback: boolean;
  tailscaleFallback: boolean;
  tailscaleAvailable: boolean;
  pairingExpired: boolean;
  setupTimedOut: boolean;
  setEmail: (email: string) => void;
  setCode: (code: string) => void;
  changeEmail: () => void;
  start: () => void;
  useLocal: () => void;
  useTailscale: () => void;
  requestCode: () => void;
  verifyCode: () => void;
  retryAccount: () => void;
  cancel: () => void;
  refreshCode: () => void;
  finish: () => void;
  skip: () => void;
  act: (call: (companion: CompanionBridge) => Promise<CompanionState>) => Promise<void>;
  accountAct: (call: (remote: AccountBridge) => Promise<CompanionAccountState>) => Promise<void>;
}

export function usePhoneSetupController(profileEmail = ""): PhoneSetupController {
  const [state, setState] = useState<CompanionState | null>(null);
  const [account, setAccount] = useState<CompanionAccountState | null>(null);
  const [email, setEmailState] = useState(profileEmail);
  const [code, setCodeState] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [setupTimedOut, setSetupTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [flow, dispatchFlow] = useReducer(phoneSetupReducer, initialPhoneSetupFlowState);
  const emailEdited = useRef(false);
  const pairingUiOwner = useRef<PhonePairingAttemptLock>({ generation: null });
  const pairingAttemptQueue = useRef<PhonePairingAttemptQueue<PhonePairingRequest>>({
    active: null,
    pending: null,
  });
  const runPairingAttemptRef = useRef<(request: PhonePairingRequest) => Promise<void>>(
    async () => {},
  );
  const pairingRoutePinRef = useRef<OwnedCompanionPairingRoutePin | null>(null);
  const [pairingRoutePinState, setPairingRoutePinState] =
    useState<OwnedCompanionPairingRoutePin | null>(null);
  const setupGeneration = useRef(0);
  const mounted = useRef(true);
  const companionMutationEpoch = useRef(0);
  const loadInFlight = useRef<Promise<void> | null>(null);

  const publishPairingRoutePin = useCallback((pin: OwnedCompanionPairingRoutePin | null) => {
    pairingRoutePinRef.current = pin;
    setPairingRoutePinState(pin);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setupGeneration.current += 1;
    };
  }, []);

  const load = useCallback((): Promise<void> => {
    if (loadInFlight.current) return loadInFlight.current;
    const refreshEpoch = companionMutationEpoch.current;
    const pending = (async () => {
      const next = await loadCompanionBridgeState(companionBridge(), companionAccountBridge());
      if (!mounted.current) return;
      if (
        next.companion
        && companionStateRefreshIsCurrent(companionMutationEpoch, refreshEpoch)
      ) {
        setState(next.companion);
      }
      if (next.account) {
        setAccount(next.account);
        if (shouldHydrateCompanionEmail(emailEdited.current, next.account)) {
          setEmailState(next.account.email ?? "");
        }
      }
    })().finally(() => {
      if (loadInFlight.current === pending) loadInFlight.current = null;
    });
    loadInFlight.current = pending;
    return pending;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!emailEdited.current && profileEmail) setEmailState(profileEmail);
  }, [profileEmail]);

  const act = useCallback(async (call: (companion: CompanionBridge) => Promise<CompanionState>) => {
    const companion = companionBridge();
    if (!companion) return;
    setActionBusy(true);
    setError(null);
    try {
      const next = await mutateCompanionBridgeState(
        companionMutationEpoch,
        () => call(companion),
      );
      if (mounted.current) setState(next);
    } catch (cause) {
      if (mounted.current) setError(
        normalizePhoneSetupActionError(
          cause,
          "Phone access could not be updated. Open Advanced & troubleshooting and try again.",
        ),
      );
    } finally {
      if (mounted.current) setActionBusy(false);
    }
  }, []);

  const accountAct = useCallback(
    async (call: (remote: AccountBridge) => Promise<CompanionAccountState>) => {
      const remote = companionAccountBridge();
      if (!remote) return;
      setAccountBusy(true);
      setAccountError(null);
      try {
        const next = await mutateCompanionBridgeState(
          companionMutationEpoch,
          () => call(remote),
        );
        if (!mounted.current) return;
        setAccount(next);
        await load();
      } catch (cause) {
        if (mounted.current) setAccountError(normalizePhoneSetupActionError(
          cause,
          "Secure phone access could not be updated. Try again.",
        ));
      } finally {
        if (mounted.current) setAccountBusy(false);
      }
    },
    [load],
  );

  const runPairingAttempt = useCallback(
    async ({ routeMode, accountOverride, generation }: PhonePairingRequest) => {
      const finishAttempt = () => {
        if (releasePhonePairingAttempt(pairingUiOwner.current, generation) && mounted.current) {
          setPairingBusy(false);
        }
        const next = completePhonePairingAttempt(pairingAttemptQueue.current, generation);
        if (next) void runPairingAttemptRef.current(next);
      };
      const isCurrent = () => mounted.current && setupGeneration.current === generation;
      if (!isCurrent()) {
        finishAttempt();
        return;
      }
      const companion = companionBridge();
      if (!companion) {
        if (mounted.current && setupGeneration.current === generation) {
          setError("Phone setup is only available in the desktop app.");
        }
        finishAttempt();
        return;
      }
      const staleAttemptMayClose = () => {
        const activePin = pairingRoutePinRef.current;
        return !activePin || activePin.generation === generation;
      };
      const previousPin = pairingRoutePinRef.current;
      if (previousPin && previousPin.generation !== generation) {
        publishPairingRoutePin(null);
        setState((current) => current?.pairing?.token === previousPin.token
          ? { ...current, pairing: null }
          : current);
      }
      setError(null);
      try {
        const started = state?.enabled
          ? await companion.state()
          : await mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.start(),
            );
        if (!isCurrent()) return;
        setState(started);
        const startFailure = companionStartFailure(started);
        if (startFailure) {
          setProvisioning(false);
          setError(startFailure);
          dispatchFlow({ type: "reset" });
          return;
        }
        const explicitRoute = routeMode !== "automatic";
        const gate = phonePairingGate(accountOverride ?? account, started, explicitRoute);
        if (gate !== "open") {
          setProvisioning(gate === "wait" || gate === "start");
          return;
        }
        if (explicitRoute && !companionPairingRoute(started, routeMode)) {
          setProvisioning(false);
          setError(routeMode === "tailscale"
            ? TAILSCALE_PAIRING_UNAVAILABLE
            : DIRECT_PAIRING_UNAVAILABLE);
          dispatchFlow({ type: "reset" });
          return;
        }
        const paired = await keepPhonePairingIfCurrent(
          () => mutateCompanionBridgeState(
            companionMutationEpoch,
            () => companion.pairing(true),
          ),
          (opened) => closePhonePairingIfOwned(
            opened,
            () => companion.state(),
            () => mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.pairing(false, opened.pairing?.token),
            ),
            staleAttemptMayClose,
          ),
          isCurrent,
        );
        if (!paired) return;

        const pairingWindow = paired.pairing;
        const pairingFailure = companionPairingOpenFailure(
          paired,
          started.pairing?.token ?? null,
        );
        const routePin = pairingFailure ? null : companionPairingRoutePin(paired, routeMode);
        if (pairingFailure || !routePin || !pairingWindow) {
          await closePhonePairingIfOwned(
            paired,
            () => companion.state(),
            () => mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.pairing(false, paired.pairing?.token),
            ),
            isCurrent,
          );
          if (!isCurrent()) return;
          publishPairingRoutePin(null);
          setState({ ...paired, pairing: null });
          setProvisioning(false);
          setError(pairingFailure ?? (routeMode === "local"
            ? DIRECT_PAIRING_UNAVAILABLE
            : routeMode === "tailscale"
              ? TAILSCALE_PAIRING_UNAVAILABLE
              : PROTECTED_PAIRING_UNAVAILABLE));
          dispatchFlow({ type: "reset" });
          return;
        }
        publishPairingRoutePin({
          ...routePin,
          generation,
          token: pairingWindow.token,
        });
        setState(paired);
        setProvisioning(false);
        setSetupTimedOut(false);
        dispatchFlow({
          type: "pairing-opened",
          deviceIds: paired.devices.map((device) => device.id),
        });
      } catch (cause) {
        if (!isCurrent()) return;
        publishPairingRoutePin(null);
        setProvisioning(false);
        setError(normalizePhoneSetupActionError(
          cause,
          "Phone pairing could not be prepared. Open Advanced & troubleshooting and try again.",
        ));
        dispatchFlow({ type: "reset" });
      } finally {
        finishAttempt();
      }
    },
    [account, publishPairingRoutePin, state],
  );

  useLayoutEffect(() => {
    runPairingAttemptRef.current = runPairingAttempt;
  }, [runPairingAttempt]);

  const openPairing = useCallback((
    routeMode: CompanionPairingRouteMode,
    accountOverride?: CompanionAccountState | null,
    generation = setupGeneration.current,
  ) => {
    const request = { routeMode, accountOverride, generation };
    const decision = queuePhonePairingAttempt(pairingAttemptQueue.current, request);
    if (decision === "duplicate") return;
    claimPhonePairingAttempt(pairingUiOwner.current, generation);
    setPairingBusy(true);
    if (decision === "start") void runPairingAttemptRef.current(request);
  }, []);

  const start = useCallback(() => {
    const baseline = phoneSetupBaseline(state?.devices ?? null);
    if (!baseline) return;
    const generation = ++setupGeneration.current;
    dispatchFlow({ type: "start", deviceIds: baseline });
    setError(null);
    setAccountError(null);
    setSetupTimedOut(false);
    if (
      phonePairingGate(account, state, false) === "open"
      || (account?.available && (account.status === "ready" || account.status === "connecting"))
    ) {
      setProvisioning(true);
      void openPairing("automatic", account, generation);
    }
  }, [account, openPairing, state]);

  const useLocal = useCallback(() => {
    const baseline = phoneSetupBaseline(state?.devices ?? null);
    if (!baseline) return;
    if (!flow.active) {
      dispatchFlow({ type: "start", deviceIds: baseline });
    }
    const generation = ++setupGeneration.current;
    dispatchFlow({ type: "use-local" });
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void openPairing("local", undefined, generation);
  }, [flow.active, openPairing, state?.devices]);

  const useTailscale = useCallback(() => {
    const baseline = phoneSetupBaseline(state?.devices ?? null);
    if (!baseline) return;
    if (!flow.active) {
      dispatchFlow({ type: "start", deviceIds: baseline });
    }
    const generation = ++setupGeneration.current;
    dispatchFlow({ type: "use-tailscale" });
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void openPairing("tailscale", undefined, generation);
  }, [flow.active, openPairing, state?.devices]);

  const requestCode = useCallback(() => {
    const remote = companionAccountBridge();
    const normalized = email.trim().toLowerCase();
    if (!remote || !normalized) return;
    const generation = setupGeneration.current;
    setAccountBusy(true);
    setAccountError(null);
    void remote
      .requestCode(normalized)
      .then((next) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccount(next);
        setCodeSent(true);
      })
      .catch((cause: unknown) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccountError(
          normalizePhoneSetupActionError(cause, "We could not send the code. Try again."),
        );
      })
      .finally(() => {
        if (mounted.current && setupGeneration.current === generation) setAccountBusy(false);
      });
  }, [email]);

  const verifyCode = useCallback(() => {
    const remote = companionAccountBridge();
    const normalized = email.trim().toLowerCase();
    if (!remote || code.length !== 8) return;
    const generation = setupGeneration.current;
    setAccountBusy(true);
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void mutateCompanionBridgeState(
      companionMutationEpoch,
      () => remote.verifyCode(normalized, code),
    )
      .then(async (next) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccount(next);
        setCodeState("");
        setCodeSent(false);
        await openPairing("automatic", next, generation);
      })
      .catch((cause: unknown) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setProvisioning(false);
        setAccountError(
          normalizePhoneSetupActionError(cause, "That code could not be verified. Try again."),
        );
      })
      .finally(() => {
        if (mounted.current && setupGeneration.current === generation) setAccountBusy(false);
      });
  }, [code, email, openPairing]);

  const retryAccount = useCallback(() => {
    const remote = companionAccountBridge();
    if (!remote) return;
    const baseline = flow.active ? phoneSetupBaseline(state?.devices ?? null) : null;
    const generation = ++setupGeneration.current;
    if (baseline) dispatchFlow({ type: "start", deviceIds: baseline });
    setAccountBusy(true);
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void mutateCompanionBridgeState(
      companionMutationEpoch,
      () => remote.retry(),
    )
      .then(async (next) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccount(next);
        if (flow.active) await openPairing("automatic", next, generation);
        else {
          await load();
          if (mounted.current && setupGeneration.current === generation) setProvisioning(false);
        }
      })
      .catch((cause: unknown) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setProvisioning(false);
        setAccountError(
          normalizePhoneSetupActionError(cause, "Secure access could not be restored. Try again."),
        );
      })
      .finally(() => {
        if (mounted.current && setupGeneration.current === generation) setAccountBusy(false);
      });
  }, [flow.active, load, openPairing, state?.devices]);

  const phase = derivePhoneSetupPhase(flow, {
    accountStatus: account?.available ? account.status : "unavailable",
    accountBusy,
    provisioning,
    provisioningTimedOut: setupTimedOut,
    pairingOpen: Boolean(
      state?.pairing
      && pairingRoutePinState?.token === state.pairing.token,
    ),
  });

  useEffect(() => {
    if (
      !flow.active
      || flow.localFallback
      || flow.tailscaleFallback
      || !account
      || (account.available && account.status !== "signed-out" && account.status !== "error")
    ) {
      return;
    }
    setProvisioning(false);
  }, [account, flow.active, flow.localFallback, flow.tailscaleFallback]);

  useEffect(() => {
    if (!shouldArmPhoneSetupProvisioningTimeout(flow, {
      provisioning,
      provisioningTimedOut: setupTimedOut,
    })) return;
    const timer = window.setTimeout(() => {
      const timedOutGeneration = setupGeneration.current;
      setupGeneration.current += 1;
      invalidatePhonePairingAttempt(pairingAttemptQueue.current, timedOutGeneration);
      releasePhonePairingAttempt(pairingUiOwner.current, timedOutGeneration);
      setPairingBusy(false);
      setAccountBusy(false);
      setProvisioning(false);
      setSetupTimedOut(true);
    }, PHONE_SETUP_PROVISIONING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [flow, provisioning, setupTimedOut]);

  useEffect(() => {
    const pin = pairingRoutePinState;
    if (!pin || !state) return;
    if (!state.pairing) {
      publishPairingRoutePin(null);
      return;
    }

    const tokenMatches = state.pairing.token === pin.token;
    const routeAvailable = companionPairingRoutePinAvailable(state, pin);
    if (tokenMatches && routeAvailable) return;

    const companion = companionBridge();
    if (setupGeneration.current === pin.generation) setupGeneration.current += 1;
    invalidatePhonePairingAttempt(pairingAttemptQueue.current, pin.generation);
    releasePhonePairingAttempt(pairingUiOwner.current, pin.generation);
    setPairingBusy(false);
    publishPairingRoutePin(null);
    setState((current) => current ? { ...current, pairing: null } : current);
    setProvisioning(false);
    setSetupTimedOut(false);
    const routeError = pin.protectedEndpoint?.kind === "tailnet"
      ? TAILSCALE_PAIRING_UNAVAILABLE
      : pin.protectedEndpoint === null
        ? DIRECT_PAIRING_UNAVAILABLE
        : PROTECTED_PAIRING_UNAVAILABLE;
    setError(tokenMatches
      ? routeError
      : "The pairing code changed before setup finished.  Create a new code and try again.");
    dispatchFlow({ type: "reset" });

    if (tokenMatches && companion) {
      void closePhonePairingIfOwned(
        state,
        () => companion.state(),
        () => mutateCompanionBridgeState(
          companionMutationEpoch,
          () => companion.pairing(false, state.pairing?.token),
        ),
        () => {
          const activePin = pairingRoutePinRef.current;
          return !activePin || activePin.generation === pin.generation;
        },
      );
    }
  }, [pairingRoutePinState, publishPairingRoutePin, state]);

  useEffect(() => {
    if (!state) return;
    const device = newlyPairedDeviceForFlow(flow, state.devices);
    if (device) dispatchFlow({ type: "paired", deviceName: device.name });
  }, [flow, state]);

  useEffect(() => {
    if (
      !flow.active ||
      flow.localFallback ||
      flow.tailscaleFallback ||
      flow.pairingAttempted ||
      setupTimedOut ||
      !state ||
      phonePairingGate(account, state, false) !== "open"
    ) {
      return;
    }
    void openPairing("automatic");
  }, [account, flow.active, flow.localFallback, flow.pairingAttempted, flow.tailscaleFallback, openPairing, setupTimedOut, state]);

  const shouldPoll = flow.active || Boolean(state?.pairing);
  useEffect(() => {
    return startNonOverlappingPhoneSetupPoll(
      () => {
        setNow(Date.now());
        return load();
      },
      shouldPoll ? 1_000 : 10_000,
    );
  }, [load, shouldPoll]);

  const pairingRouteMode: CompanionPairingRouteMode = flow.localFallback
    ? "local"
    : flow.tailscaleFallback
      ? "tailscale"
      : "automatic";
  const pairingRoute = useMemo(
    () => {
      if (!state) return null;
      if (state.pairing) {
        return pairingRoutePinState?.token === state.pairing.token
          ? pairingRoutePinState.route
          : null;
      }
      return companionPairingRoute(state, pairingRouteMode);
    },
    [pairingRouteMode, pairingRoutePinState, state],
  );
  const pairingLink = useMemo(() => {
    if (!state?.pairing || !pairingRoute) return null;
    return companionPairingLink({
      ...pairingRoute,
      code: state.pairing.code,
      token: state.pairing.token,
      name: state.discovery?.name,
    });
  }, [pairingRoute, state]);

  const cancel = useCallback(() => {
    const cancelledGeneration = setupGeneration.current;
    setupGeneration.current += 1;
    invalidatePhonePairingAttempt(pairingAttemptQueue.current, cancelledGeneration);
    releasePhonePairingAttempt(pairingUiOwner.current, cancelledGeneration);
    setPairingBusy(false);
    const snapshot = state;
    const companion = companionBridge();
    publishPairingRoutePin(null);
    setState((current) => current ? { ...current, pairing: null } : current);
    if (companion && snapshot?.pairing) {
      void closePhonePairingIfOwned(
        snapshot,
        () => companion.state(),
        () => mutateCompanionBridgeState(
          companionMutationEpoch,
          () => companion.pairing(false, snapshot.pairing?.token),
        ),
        () => pairingRoutePinRef.current === null,
      );
    }
    setProvisioning(false);
    setAccountBusy(false);
    setSetupTimedOut(false);
    setCodeSent(false);
    setCodeState("");
    dispatchFlow({ type: "reset" });
  }, [publishPairingRoutePin, state]);

  return {
    state,
    account,
    phase,
    email,
    code,
    codeSent,
    busy: actionBusy || pairingBusy,
    accountBusy,
    error,
    accountError,
    pairingLink,
    secondsLeft: state?.pairing
      ? Math.max(0, Math.round((state.pairing.expiresAt - now) / 1000))
      : 0,
    address: pairingRoute?.address,
    pairingPort: pairingRoute?.port ?? state?.port ?? 8810,
    hostedReady: Boolean(state?.endpoints?.some((endpoint) => endpoint.kind === "hosted")),
    localFallback: flow.localFallback,
    tailscaleFallback: flow.tailscaleFallback,
    tailscaleAvailable: Boolean(state && companionPairingRoute(state, "tailscale")),
    pairingExpired: flow.pairingAttempted && !state?.pairing,
    setupTimedOut,
    setEmail: (next) => {
      emailEdited.current = true;
      setEmailState(next);
    },
    setCode: (next) => setCodeState(next.replaceAll(/\D/g, "").slice(0, 8)),
    changeEmail: () => {
      setCodeState("");
      setCodeSent(false);
      setAccountError(null);
    },
    start,
    useLocal,
    useTailscale,
    requestCode,
    verifyCode,
    retryAccount,
    cancel,
    refreshCode: () => {
      const generation = ++setupGeneration.current;
      void openPairing(pairingRouteMode, undefined, generation);
    },
    finish: () => {
      const generation = setupGeneration.current;
      setupGeneration.current += 1;
      invalidatePhonePairingAttempt(pairingAttemptQueue.current, generation);
      releasePhonePairingAttempt(pairingUiOwner.current, generation);
      setPairingBusy(false);
      publishPairingRoutePin(null);
      setSetupTimedOut(false);
      dispatchFlow({ type: "reset" });
    },
    skip: () => {
      const generation = setupGeneration.current;
      setupGeneration.current += 1;
      invalidatePhonePairingAttempt(pairingAttemptQueue.current, generation);
      releasePhonePairingAttempt(pairingUiOwner.current, generation);
      setPairingBusy(false);
      publishPairingRoutePin(null);
      dispatchFlow({ type: "skip" });
    },
    act,
    accountAct,
  };
}

function ValuePoints() {
  const points: Array<{ Icon: typeof Smartphone; title: string; detail: string }> = [
    { Icon: Smartphone, title: "Your Chats", detail: "Read and reply from your phone." },
    { Icon: Check, title: "Quick Approvals", detail: "Keep work moving when you step away." },
    { Icon: ShieldCheck, title: "Private by Default", detail: "Only phones you approve can connect." },
  ];
  return (
    <div className="mt-5 grid w-full gap-2 sm:grid-cols-3">
      {points.map(({ Icon, title, detail }) => (
        <div key={title} className="rounded-xl bg-inset px-3 py-3 text-left">
          <Icon size={16} className="text-accent" />
          <div className="mt-2 text-[13px] font-medium text-ink">{title}</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{detail}</div>
        </div>
      ))}
    </div>
  );
}

const endpointHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function PhoneSetupFlowView({
  controller,
  variant,
  onSkip,
  onComplete,
}: {
  controller: PhoneSetupController;
  variant: "settings" | "onboarding";
  onSkip?: () => void;
  onComplete?: () => void;
}) {
  const c = controller;
  const actionError = companionAccountActionError(c.account, c.accountError);
  const canSubmitEmail = /^\S+@\S+\.\S+$/.test(c.email.trim());
  const manualCodeMode = phonePairingManualCodeMode(Boolean(c.state?.pairing), c.pairingLink);

  if (c.phase === "intro") {
    if (variant === "settings") {
      const hostedEndpoint = c.state?.endpoints?.find((e) => e.kind === "hosted");
      const hostedHost = hostedEndpoint ? endpointHost(hostedEndpoint.url) : null;
      const tailscaleHost = c.state?.tailnetName
        ? `${c.state.tailnetName}:${c.state.port}`
        : c.state?.tailscale
          ? `${c.state.tailscale}:${c.state.port}`
          : null;
      const lanHost = c.state?.lan ? `${c.state.lan}:${c.state.port}` : null;

      return (
        <div className="flex flex-col gap-4 text-left">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[16px] font-semibold text-ink">
                {c.state?.devices.length ? "Pair Another Phone" : "Pair a Phone"}
              </h2>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
                Select a route below to create an instant pairing QR code for your iPhone.
              </p>
            </div>
            <button
              onClick={c.start}
              disabled={!c.state || c.busy || c.accountBusy}
              className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-40"
            >
              {c.state?.devices.length ? "Pair (Auto Select)" : "Pair a Phone"}
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {/* Route 1: Tailscale */}
            <div className="flex flex-col justify-between rounded-xl border border-hairline/40 bg-inset p-3.5">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={16} className={c.tailscaleAvailable ? "text-accent" : "text-ink-secondary"} />
                    <span className="text-[13px] font-semibold text-ink">Tailscale</span>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                      c.tailscaleAvailable ? "bg-success/15 text-success" : "bg-control text-ink-secondary"
                    }`}
                  >
                    {c.tailscaleAvailable ? "Connected" : "Offline"}
                  </span>
                </div>
                <div className="mt-2 truncate font-mono text-[11.5px] text-ink-secondary" title={tailscaleHost ?? "Not connected"}>
                  {tailscaleHost ?? "Tailnet not detected"}
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
                  Direct private mesh.  Best when your phone is signed in to Tailscale.
                </p>
              </div>
              <button
                onClick={c.useTailscale}
                disabled={!c.tailscaleAvailable || c.busy || c.accountBusy}
                className="mt-3 w-full rounded-lg border border-hairline/50 bg-control/60 py-1.5 text-[12px] font-medium text-ink hover:bg-control disabled:opacity-40"
              >
                Pair over Tailscale
              </button>
            </div>

            {/* Route 2: Companion Gateway */}
            <div className="flex flex-col justify-between rounded-xl border border-hairline/40 bg-inset p-3.5">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Cloud size={16} className={c.hostedReady ? "text-accent" : "text-ink-secondary"} />
                    <span className="text-[13px] font-semibold text-ink">Gateway</span>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                      c.hostedReady ? "bg-success/15 text-success" : "bg-control text-ink-secondary"
                    }`}
                  >
                    {c.hostedReady ? "Ready" : "Port 8810"}
                  </span>
                </div>
                <div className="mt-2 truncate font-mono text-[11.5px] text-ink-secondary" title={hostedHost ?? "Cloudflare Tunnel (port 8810)"}>
                  {hostedHost ?? "Cloudflare Tunnel (8810)"}
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
                  Works away from home on cellular or travel Wi-Fi without VPN.
                </p>
              </div>
              <button
                onClick={c.start}
                disabled={!c.state || c.busy || c.accountBusy}
                className="mt-3 w-full rounded-lg bg-accent/90 py-1.5 text-[12px] font-medium text-white hover:bg-accent disabled:opacity-40"
              >
                Pair via Gateway
              </button>
            </div>

            {/* Route 3: Local Wi-Fi */}
            <div className="flex flex-col justify-between rounded-xl border border-hairline/40 bg-inset p-3.5">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Wifi size={16} className={lanHost ? "text-accent" : "text-ink-secondary"} />
                    <span className="text-[13px] font-semibold text-ink">Local Wi-Fi</span>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                      lanHost ? "bg-success/15 text-success" : "bg-control text-ink-secondary"
                    }`}
                  >
                    {lanHost ? "Available" : "No LAN"}
                  </span>
                </div>
                <div className="mt-2 truncate font-mono text-[11.5px] text-ink-secondary" title={lanHost ?? "Not connected"}>
                  {lanHost ?? "No local IP"}
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
                  Direct LAN connection when both devices are on the same local network.
                </p>
              </div>
              <button
                onClick={c.useLocal}
                disabled={!lanHost || c.busy || c.accountBusy}
                className="mt-3 w-full rounded-lg border border-hairline/50 bg-control/60 py-1.5 text-[12px] font-medium text-ink hover:bg-control disabled:opacity-40"
              >
                Pair on Wi-Fi
              </button>
            </div>
          </div>

          {c.error && <p role="alert" className="mt-1 text-[12.5px] text-danger">{c.error}</p>}
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/12 text-accent">
          <Smartphone size={26} />
        </div>
        <h2 className="mt-4 text-[19px] font-semibold text-ink">Use BotFleet from Your Phone</h2>
        <p className="mt-1.5 max-w-[460px] text-[13.5px] leading-relaxed text-ink-secondary">
          Check chats, answer approvals, and send new work without staying at your computer.
        </p>
        <ValuePoints />
        <button
          onClick={c.start}
          disabled={!c.state || c.busy || c.accountBusy}
          className="mt-5 w-full max-w-[320px] rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-40"
        >
          Set Up My Phone
        </button>
        {c.error && <p role="alert" className="mt-3 max-w-[390px] text-[12.5px] text-danger">{c.error}</p>}
        {variant === "onboarding" && (
          <>
            <button
              onClick={() => {
                c.skip();
                onSkip?.();
              }}
              className="mt-2.5 text-[12.5px] text-ink-secondary hover:text-ink"
            >
              Not Now
            </button>
            <p className="mt-2 text-[11.5px] text-ink-secondary">
              You can resume anytime from Settings → Phone.
            </p>
          </>
        )}
      </div>
    );
  }

  if (c.phase === "sign-in") {
    // No hosted control plane in this build: say so plainly and offer the
    // routes that do exist, instead of "needs attention" plus a retry that
    // can never succeed.
    const unconfigured = c.account?.configured === false;
    const unavailable = !c.account?.available;
    const failed = c.account?.status === "error" || c.setupTimedOut;
    return (
      <div className="mx-auto flex w-full max-w-[430px] flex-col">
        <button onClick={c.cancel} className="mb-4 flex w-fit items-center gap-1.5 text-[12px] text-ink-secondary hover:text-ink">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="flex size-11 items-center justify-center rounded-xl bg-accent/12 text-accent">
          <Mail size={20} />
        </div>
        <h2 className="mt-3 text-[18px] font-semibold text-ink">
          {unconfigured
            ? "Pair on your own network"
            : unavailable || failed
              ? "Secure access needs attention"
              : "Sign in to pair securely"}
        </h2>
        <p
          role={c.setupTimedOut ? "alert" : undefined}
          className="mt-1 text-[13px] leading-relaxed text-ink-secondary"
        >
          {unconfigured
            ? "Secure online access is not configured in this build.\u00a0 Pair directly on the same Wi-Fi, or over Tailscale when both devices share a tailnet."
            : unavailable
            ? "Online phone access is not available right now. You can still pair directly on the same Wi-Fi."
            : c.setupTimedOut
              ? "Secure access is taking longer than expected. You can try again or pair directly on this Wi-Fi."
            : failed
              ? c.account?.message ?? "We could not finish creating your private connection."
              : "We’ll email you a one-time code. No password needed."}
        </p>

        {!unavailable && !failed && (
          <div className="mt-5 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink-secondary">Email</span>
              <input
                autoFocus
                autoComplete="email"
                inputMode="email"
                value={c.email}
                disabled={c.accountBusy || c.codeSent}
                onChange={(event) => c.setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !c.codeSent && canSubmitEmail) c.requestCode();
                }}
                placeholder="you@example.com"
                className="rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent disabled:opacity-50"
              />
            </label>
            {c.codeSent && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-ink-secondary">8-digit code</span>
                <input
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={c.code}
                  disabled={c.accountBusy}
                  onChange={(event) => c.setCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && c.code.length === 8) c.verifyCode();
                  }}
                  placeholder="12345678"
                  className="rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 font-mono text-[16px] tracking-[0.18em] text-ink outline-none placeholder:tracking-normal placeholder:text-ink-secondary/60 focus:border-accent disabled:opacity-50"
                />
              </label>
            )}
            <button
              disabled={c.accountBusy || (!c.codeSent && !canSubmitEmail) || (c.codeSent && c.code.length !== 8)}
              onClick={c.codeSent ? c.verifyCode : c.requestCode}
              className="rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {c.accountBusy ? "Working…" : c.codeSent ? "Verify and Continue" : "Email Me a Code"}
            </button>
            {c.codeSent && (
              <button
                disabled={c.accountBusy}
                onClick={c.changeEmail}
                className="text-[12px] text-ink-secondary hover:text-ink disabled:opacity-40"
              >
                Use Another Email
              </button>
            )}
            {c.codeSent && !actionError && (
              <p className="text-[11.5px] text-ink-secondary">The code expires in 10 minutes.</p>
            )}
          </div>
        )}

        {(unavailable || failed) && !unconfigured && (
          <button
            disabled={c.accountBusy}
            onClick={c.retryAccount}
            className="mt-5 rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white disabled:opacity-40"
          >
            {c.accountBusy ? "Trying again…" : "Try Secure Access Again"}
          </button>
        )}
        {actionError && <p role="alert" className="mt-3 text-[12.5px] text-danger">{actionError}</p>}
        <div className="my-4 flex items-center gap-3 text-[11px] text-ink-secondary">
          <span className="h-px flex-1 bg-hairline/40" /> or <span className="h-px flex-1 bg-hairline/40" />
        </div>
        {c.tailscaleAvailable && (
          <>
            <button
              disabled={c.busy || c.accountBusy}
              onClick={c.useTailscale}
              className="flex items-center justify-center gap-2 rounded-lg border border-hairline/50 py-2.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
            >
              <ShieldCheck size={15} /> Pair over Tailscale
            </button>
            <p className="mt-2 text-center text-[11px] leading-relaxed text-ink-secondary">
              Your iPhone must be signed in to the same tailnet.
            </p>
          </>
        )}
        <button
          disabled={c.busy || c.accountBusy}
          onClick={c.useLocal}
          className={`${c.tailscaleAvailable ? "mt-3" : ""} flex items-center justify-center gap-2 rounded-lg border border-hairline/50 py-2.5 text-[13px] text-ink hover:bg-control disabled:opacity-40`}
        >
          <Wifi size={15} /> Pair on this Wi-Fi instead
        </button>
        <p className="mt-2 text-center text-[11px] leading-relaxed text-ink-secondary">
          Both devices must be on a network that lets them see each other.
        </p>
      </div>
    );
  }

  if (c.phase === "verifying") {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/12 text-accent">
          <Loader2 size={25} className="animate-spin" />
        </div>
        <h2 className="mt-4 text-[18px] font-semibold text-ink">
          {c.localFallback
            ? "Preparing your pairing code"
            : c.tailscaleFallback
              ? "Preparing Tailscale pairing"
              : "Creating secure phone access"}
        </h2>
        <p className="mt-1.5 max-w-[360px] text-[13px] leading-relaxed text-ink-secondary">
          {c.localFallback
            ? "This should only take a moment."
            : c.tailscaleFallback
              ? "Your pairing code will use your private tailnet connection."
            : "We’re giving this computer a private connection that works even when your phone is away from this Wi-Fi."}
        </p>
        {(c.error || c.accountError) && (
          <p role="alert" className="mt-3 max-w-[380px] text-[12.5px] text-danger">{c.error ?? c.accountError}</p>
        )}
        <button onClick={c.cancel} className="mt-5 text-[12px] text-ink-secondary hover:text-ink">Cancel</button>
      </div>
    );
  }

  if (c.phase === "success") {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-success/15 text-success">
          <Check size={28} />
        </div>
        <h2 className="mt-4 text-[19px] font-semibold text-ink">Your phone is ready</h2>
        <p className="mt-1.5 text-[13px] text-ink-secondary">
          It can now open chats, answer approvals, and send new work.
        </p>
        <button
          onClick={() => {
            c.finish();
            onComplete?.();
          }}
          className="mt-5 w-full max-w-[280px] rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white"
        >
          {variant === "onboarding" ? "Start using BotFleet" : "Done"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-white text-black">
        <QrCode size={23} />
      </div>
      <h2 className="mt-3 text-[18px] font-semibold text-ink">
        {c.pairingExpired ? "That code expired" : "Scan with your iPhone"}
      </h2>
      <p className="mt-1 text-[13px] text-ink-secondary">
        {c.pairingExpired
          ? "Create a fresh code when your phone is ready."
          : "Open BotFleet on your iPhone and scan this code."}
      </p>
      {!c.pairingExpired && c.pairingLink && (
        <div className="mt-4 rounded-2xl bg-white p-3.5" aria-label="Phone pairing QR code">
          <QRCodeSVG value={c.pairingLink} size={180} level="M" bgColor="#ffffff" fgColor="#111111" />
        </div>
      )}
      {!c.pairingExpired && manualCodeMode === "direct" && c.state?.pairing && (
        <div className="mt-4 w-full max-w-[320px] rounded-xl bg-inset px-4 py-3 text-[12.5px] text-ink-secondary">
          <div>Open BotFleetMobile and enter this manual code.</div>
          <div className="mt-2 font-mono text-[22px] tracking-[0.25em] text-ink">
            {c.state.pairing.code}
          </div>
        </div>
      )}
      {!c.pairingExpired && manualCodeMode === "details" && c.state?.pairing && (
        <p className="mt-3 text-[11.5px] text-ink-secondary">Code expires in {c.secondsLeft}s</p>
      )}
      {c.pairingExpired && (
        <button onClick={c.refreshCode} className="mt-5 rounded-lg bg-accent px-5 py-2.5 text-[14px] font-medium text-white">
          Create a new code
        </button>
      )}
      {!c.pairingExpired && c.state?.pairing && (
        <details className="mt-4 w-full max-w-[390px] rounded-lg border border-hairline/40 px-3 py-2 text-left">
          <summary className="cursor-pointer text-[12px] text-ink-secondary">Having trouble?</summary>
          <div className="mt-3 text-[12px] text-ink-secondary">
            Manual code
            <div className="mt-1 font-mono text-[22px] tracking-[0.25em] text-ink">{c.state.pairing.code}</div>
            {c.address && (
              <div className="mt-3">
                <ConnectionDetail label="Pairing address" value={`${c.address}:${c.pairingPort}`} />
              </div>
            )}
          </div>
        </details>
      )}
      <button onClick={c.cancel} className="mt-4 text-[12px] text-ink-secondary hover:text-ink">Cancel</button>
    </div>
  );
}

export function PhoneSetupFlow({
  profileEmail,
  variant,
  onSkip,
  onComplete,
}: {
  profileEmail?: string;
  variant: "settings" | "onboarding";
  onSkip?: () => void;
  onComplete?: () => void;
}) {
  const controller = usePhoneSetupController(profileEmail);
  return (
    <PhoneSetupFlowView
      controller={controller}
      variant={variant}
      onSkip={onSkip}
      onComplete={onComplete}
    />
  );
}

export { companionPairingMode };

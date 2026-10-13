import { TranscriptionSettings } from "./TranscriptionSettings";

/** Visual harness for the real call-dictation provider selector. */
export default function TranscriptionSettingsVisualFixture() {
  return (
    <main className="min-h-screen bg-app p-6 text-ink">
      <section className="mx-auto w-full max-w-[720px] rounded-xl border border-hairline/40 bg-card p-4">
        <TranscriptionSettings />
      </section>
    </main>
  );
}

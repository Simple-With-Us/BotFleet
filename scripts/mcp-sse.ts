import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

// SSE gateway for the seat's stdio MCP server (scripts/mcp-server.ts), so
// remote clients - the iOS app - can reach it over authenticated HTTP/SSE.
// node:http only: this repo has no express dependency.

/** Resolve the bearer token once, from the seat secrets file or the env.
 *  Fail-closed: with no token configured there is nothing safe to compare
 *  against, so the gateway refuses to start rather than fall back to a
 *  guessable literal. */
function resolveAuthToken(): string | null {
    try {
        const envFile = fs.readFileSync(path.join(process.env.HOME || '/Users/jay', '.secrets', 'seat-mcp.env'), 'utf8');
        // Anchored to the line start, and the token runs to the first
        // whitespace: an inline comment after the value (always
        // whitespace-separated) stays out of the credential, while a '#'
        // inside the value itself is kept verbatim.
        const match = envFile.match(/^SEAT_MCP_TOKEN=(\S+)/m);
        if (match && match[1]) return match[1];
    } catch (e) { }
    const fromEnv = process.env.SEAT_MCP_TOKEN?.trim();
    return fromEnv || null;
}

const AUTH_TOKEN = resolveAuthToken();
if (!AUTH_TOKEN) {
    console.error('[FATAL] SEAT_MCP_TOKEN is not configured (checked ~/.secrets/seat-mcp.env and the environment); refusing to start unauthenticated.');
    process.exit(1);
}

const PORT = Number(process.env.PORT) || 8794;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Session { id: string; process: ChildProcess; res: ServerResponse; }
const sessions = new Map<string, Session>();

/** Kill a spawned MCP child exactly once, whether the trigger is client
 *  disconnect, response close, or natural exit. */
function killOnce(child: ChildProcess): void {
    if (child.exitCode === null && !child.killed) child.kill();
}

/** Pipe a child stdout stream of NDJSON into `emit`, one complete line at a
 *  time.  Chunks split anywhere, so split only on newlines and hold the
 *  partial tail; flush whatever remains when the stream ends. */
function pipeNdjsonLines(stream: NodeJS.ReadableStream | null, emit: (line: string) => void): void {
    if (!stream) return;
    let pending = '';
    stream.on('data', (data) => {
        pending += data.toString();
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
            if (line.trim()) emit(line);
        }
    });
    stream.on('end', () => {
        if (pending.trim()) emit(pending);
        pending = '';
    });
}

function spawnMcp(): ChildProcess {
    return spawn('pnpm', ['run', 'mcp'], { cwd: path.resolve(__dirname, '..'), stdio: ['pipe', 'pipe', 'inherit'] });
}

function sseHeaders(res: ServerResponse): void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
}

function send(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(body);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

/** Bearer auth with the iOS app's double-"Bearer" workaround.  Never logs
 *  the Authorization header: it carries the token. */
function authorize(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    console.log(`[REQUEST] ${req.method} ${url.pathname}`);

    let authHeader = req.headers.authorization || '';
    authHeader = authHeader.replace(/^Bearer\s+Bearer\s+/i, 'Bearer ');
    const providedToken = authHeader.split(' ')[1];

    if (!authHeader.startsWith('Bearer ') || providedToken !== AUTH_TOKEN) {
        console.log(`[AUTH FAILED] Missing or invalid token for ${req.method} ${url.pathname}`);
        send(res, 401, 'Unauthorized');
        return false;
    }
    return true;
}

function handleStreamablePost(req: IncomingMessage, res: ServerResponse, body: unknown): void {
    console.log(`[STREAMABLE HTTP] Got POST request`);
    const mcpProcess = spawnMcp();

    sseHeaders(res);
    pipeNdjsonLines(mcpProcess.stdout, (line) => {
        res.write(`data: ${line}\n\n`);
    });

    mcpProcess.on('exit', () => {
        res.end();
    });

    // Client disconnect must not orphan the spawned MCP server.
    res.on('close', () => {
        killOnce(mcpProcess);
    });

    mcpProcess.stdin?.write(JSON.stringify(body) + '\n');
    mcpProcess.stdin?.end();
}

function handleSseGet(req: IncomingMessage, res: ServerResponse): void {
    const sessionId = randomUUID();
    console.log(`[SSE OPEN] Session ${sessionId}`);
    sseHeaders(res);

    const mcpProcess = spawnMcp();
    sessions.set(sessionId, { id: sessionId, process: mcpProcess, res });

    res.write(`event: endpoint\ndata: /mcp/messages?sessionId=${sessionId}\n\n`);

    pipeNdjsonLines(mcpProcess.stdout, (line) => {
        res.write(`event: message\ndata: ${line}\n\n`);
    });

    // A dead MCP child means a dead session: end the stream and drop the
    // session so a later POST /mcp/messages 404s instead of writing into a
    // dead pipe.  Guarded so the req close path below stays idempotent.
    mcpProcess.on('exit', (code, signal) => {
        console.log(`[MCP EXIT] Session ${sessionId} child exited (code ${code}, signal ${signal})`);
        sessions.delete(sessionId);
        if (!res.writableEnded) res.end();
    });

    req.on('close', () => {
        console.log(`[SSE CLOSE] Session ${sessionId}`);
        killOnce(mcpProcess);
        sessions.delete(sessionId);
    });
}

const server = createServer((req, res) => {
    void (async () => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        if (!authorize(req, res, url)) return;

        if (req.method === 'POST' && (url.pathname === '/mcp' || url.pathname === '/mcp/sse')) {
            let body: unknown;
            try {
                body = await readJsonBody(req);
            } catch (e) {
                send(res, 400, 'Bad JSON');
                return;
            }
            handleStreamablePost(req, res, body);
            return;
        }

        if (req.method === 'GET' && (url.pathname === '/mcp' || url.pathname === '/mcp/sse')) {
            handleSseGet(req, res);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/mcp/messages') {
            const sessionId = url.searchParams.get('sessionId') || '';
            if (!sessionId || !sessions.has(sessionId)) {
                send(res, 404, 'Session not found');
                return;
            }
            let body: unknown;
            try {
                body = await readJsonBody(req);
            } catch (e) {
                send(res, 400, 'Bad JSON');
                return;
            }
            // The child can die while the body is in flight: the exit handler
            // deletes the session during the await above, so re-check instead
            // of trusting the earlier sessions.has().  A dead session (or a
            // child whose stdin is already gone) is a 404, never a TypeError.
            const session = sessions.get(sessionId);
            const stdin = session?.process.stdin;
            if (!session || !stdin || stdin.destroyed || !stdin.writable) {
                send(res, 404, 'Session not found');
                return;
            }
            stdin.write(JSON.stringify(body) + '\n');
            send(res, 202, 'Accepted');
            return;
        }

        console.log(`[404] Route not found: ${url.pathname}`);
        send(res, 404, 'Not found');
    })().catch((err) => {
        console.error('[ERROR]', err);
        if (!res.headersSent) send(res, 500, 'Internal error');
        else res.end();
    });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Started on ${PORT}`));

import { Buffer } from 'buffer';

if (!globalThis.Buffer) {
    globalThis.Buffer = Buffer;
}

if (!globalThis.process) {
    globalThis.process = { env: {} } as typeof process;
}

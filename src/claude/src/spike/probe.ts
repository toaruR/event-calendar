import type { Server } from 'node:http';

interface Probe {
  name: string;
  ok: boolean;
}

const p: Probe = { name: 'probe', ok: true };
const s: Server | null = null;
void s;
if (p.ok) console.log('probe-ok');

import type { AlgorithmInfo, RunRequest, RunResponse } from './types';

export async function fetchAlgorithms(): Promise<AlgorithmInfo[]> {
  const r = await fetch('/api/algorithms');
  if (!r.ok) {
    const text = await safeText(r);
    throw new Error(`Failed to fetch algorithms (${r.status}): ${text}`);
  }
  return (await r.json()) as AlgorithmInfo[];
}

export async function runAlgorithm(req: RunRequest): Promise<RunResponse> {
  const r = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req)
  });
  if (!r.ok) {
    const text = await safeText(r);
    throw new Error(`Algorithm run failed (${r.status}): ${text}`);
  }
  return (await r.json()) as RunResponse;
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return '';
  }
}

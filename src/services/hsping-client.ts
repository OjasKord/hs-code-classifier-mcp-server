import axios, { AxiosError } from 'axios';
import type { HSPingResponse } from '../types.js';
import { HSPING_BASE_URL } from '../constants.js';

export async function queryHSPing(query: string, country: string): Promise<HSPingResponse> {
  const key = process.env.HSPING_API_KEY;
  if (!key) throw new Error('HSPING_API_KEY environment variable not set');

  const response = await axios.get<HSPingResponse>(HSPING_BASE_URL, {
    params: { query, country },
    headers: { Authorization: `Bearer ${key}` },
    timeout: 10000
  });

  return response.data;
}

export async function checkHSPingHealth(): Promise<{ ok: boolean; latency_ms: number; detail?: string }> {
  const start = Date.now();
  try {
    const key = process.env.HSPING_API_KEY;
    if (!key) return { ok: false, latency_ms: 0, detail: 'HSPING_API_KEY not set' };
    await axios.get(HSPING_BASE_URL, {
      params: { query: 'wooden chair', country: 'US' },
      headers: { Authorization: `Bearer ${key}` },
      timeout: 8000
    });
    return { ok: true, latency_ms: Date.now() - start };
  } catch (err) {
    const msg = err instanceof AxiosError ? `HTTP ${err.response?.status}` : String(err);
    return { ok: false, latency_ms: Date.now() - start, detail: msg };
  }
}

export { AxiosError };

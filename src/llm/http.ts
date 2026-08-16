// Wraps fetch with an AbortController-based timeout since undici has no built-in option here.
export async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

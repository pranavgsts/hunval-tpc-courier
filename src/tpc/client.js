/**
 * Calls TPC's booking endpoint and sorts the response into one outcome:
 *   booked    - TPC saved the booking
 *   duplicate - TPC already has this consignment number
 *   rejected  - TPC refused the data or the API key; sending it again won't help
 *   unknown   - timeout, network error or 5xx; the booking may or may not exist
 */
export function createTpcClient({ apiUrl, apiKey, apiId, timeoutMs = 20_000 }) {
  return {
    async book(payload) {
      const form = new FormData();
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && value !== null && value !== '') form.append(key, String(value));
      }

      let response;
      let body;
      try {
        response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'X-Api-Key': apiKey, 'X-Api-Id': String(apiId) },
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
      } catch (error) {
        return { outcome: 'unknown', message: `Could not reach TPC: ${error.message}` };
      }

      return classify(response.status, body);
    },
  };
}

export function classify(status, body) {
  const message = body?.REF_MESSAGE || body?.errors || body?.msg || body?.raw || `HTTP ${status}`;
  const text = typeof message === 'string' ? message : JSON.stringify(message);

  if (status >= 500) return { outcome: 'unknown', status, message: text };
  if (body?.ERROR_STATUS === 'SUCCESS' && status < 300) {
    return { outcome: 'booked', status, refNo: String(body.REF_NO ?? ''), message: text };
  }
  if (/already\s+exist/i.test(text)) return { outcome: 'duplicate', status, message: text };
  if (status === 401) return { outcome: 'rejected', status, message: `TPC rejected the API key/ID: ${text}` };
  return { outcome: 'rejected', status, message: text };
}

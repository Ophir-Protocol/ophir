import type { Agreement } from './types.js';

/** Generate x402-compatible payment headers from agreed terms.
 * @param agreement - The finalized agreement containing price, currency, and escrow details
 * @returns A record of X-Payment-* headers suitable for HTTP requests
 * @example
 * ```typescript
 * const headers = agreementToX402Headers(agreement);
 * const response = await fetch(url, { headers });
 * ```
 */
export function agreementToX402Headers(
  agreement: Agreement,
): Record<string, string> {
  const terms = agreement.final_terms;
  const headers: Record<string, string> = {
    'X-Payment-Amount': terms.price_per_unit,
    'X-Payment-Currency': terms.currency,
    'X-Payment-Agreement-Id': agreement.agreement_id,
    'X-Payment-Agreement-Hash': agreement.agreement_hash,
    'X-Payment-Unit': terms.unit,
  };

  if (terms.escrow) {
    headers['X-Payment-Network'] = terms.escrow.network;
    headers['X-Payment-Escrow-Deposit'] = terms.escrow.deposit_amount;
  }

  if (agreement.escrow?.address) {
    headers['X-Payment-Escrow-Address'] = agreement.escrow.address;
  }

  return headers;
}

/**
 * Look up a header value case-insensitively.
 */
function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/** Parse x402 payment response headers into structured data.
 * @param headers - The HTTP response headers (lookup is case-insensitive per HTTP spec)
 * @returns Parsed payment details with price, currency, and paymentAddress
 * @example
 * ```typescript
 * const payment = parseX402Response(response.headers);
 * console.log(payment.price, payment.currency); // "0.01" "USDC"
 * ```
 */
export function parseX402Response(headers: Record<string, string>): {
  price: string;
  currency: string;
  paymentAddress: string;
} {
  return {
    price: getHeader(headers, 'X-Payment-Amount') ?? '0',
    currency: getHeader(headers, 'X-Payment-Currency') ?? 'USDC',
    paymentAddress: getHeader(headers, 'X-Payment-Address') ?? '',
  };
}

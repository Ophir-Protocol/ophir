/**
 * JSON-RPC 2.0 method names for the Ophir negotiation protocol.
 *
 * Each method corresponds to a step in the negotiation state machine:
 * RFQ → QUOTE → COUNTER (optional) → ACCEPT/REJECT → DISPUTE (if needed).
 */
export const METHODS = {
  /** Buyer broadcasts a Request for Quote to sellers. */
  RFQ: 'negotiate/rfq',
  /** Seller responds with pricing and SLA terms. */
  QUOTE: 'negotiate/quote',
  /** Either party proposes modified terms. */
  COUNTER: 'negotiate/counter',
  /** Both parties sign the final agreement. */
  ACCEPT: 'negotiate/accept',
  /** Either party declines and walks away. */
  REJECT: 'negotiate/reject',
  /** Buyer files an SLA violation claim. */
  DISPUTE: 'negotiate/dispute',
} as const;

/** Union type of all valid Ophir JSON-RPC method names. */
export type OphirMethod = (typeof METHODS)[keyof typeof METHODS];

/** Array of all valid Ophir JSON-RPC method names, for iteration and validation. */
export const METHOD_LIST: readonly OphirMethod[] = [
  METHODS.RFQ,
  METHODS.QUOTE,
  METHODS.COUNTER,
  METHODS.ACCEPT,
  METHODS.REJECT,
  METHODS.DISPUTE,
] as const;

/**
 * Check if a string is a valid Ophir JSON-RPC method name.
 * @param method - The string to check.
 * @returns True if the string matches one of the six Ophir methods.
 */
export function isOphirMethod(method: string): method is OphirMethod {
  return (METHOD_LIST as readonly string[]).includes(method);
}

/**
 * JSON Schema (draft 2020-12) for the Ophir SLA specification.
 */
export const SLA_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://ophir.dev/schemas/sla/v1',
  title: 'Ophir SLA Specification',
  description: 'Service Level Agreement schema for the Ophir Agent Negotiation Protocol',
  type: 'object',
  required: ['metrics'],
  properties: {
    metrics: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['name', 'target', 'comparison'],
        properties: {
          name: {
            type: 'string',
            enum: [
              'uptime_pct',
              'p50_latency_ms',
              'p99_latency_ms',
              'accuracy_pct',
              'throughput_rpm',
              'error_rate_pct',
              'time_to_first_byte_ms',
              'custom',
            ],
            description: 'The SLA metric being measured',
          },
          target: {
            type: 'number',
            description: 'Target value for the metric',
          },
          comparison: {
            type: 'string',
            enum: ['gte', 'lte', 'eq', 'between'],
            description: 'How the observed value is compared to the target',
          },
          measurement_method: {
            type: 'string',
            enum: ['rolling_average', 'percentile', 'absolute', 'sampled'],
            description: 'Method used to measure the metric',
          },
          measurement_window: {
            type: 'string',
            description: 'Time window for measurement (e.g. "1h", "24h", "7d")',
          },
          penalty_per_violation: {
            type: 'object',
            required: ['amount', 'currency'],
            properties: {
              amount: {
                type: 'string',
                description: 'Penalty amount as a decimal string',
              },
              currency: {
                type: 'string',
                description: 'Currency for the penalty (e.g. "USDC")',
              },
              max_penalties_per_window: {
                type: 'integer',
                minimum: 1,
                description: 'Maximum penalties within a measurement window',
              },
            },
            additionalProperties: false,
          },
          custom_name: {
            type: 'string',
            description: 'Name for custom metrics (required when name is "custom")',
          },
        },
        additionalProperties: false,
        if: {
          properties: { name: { const: 'custom' } },
        },
        then: {
          required: ['name', 'target', 'comparison', 'custom_name'],
        },
      },
    },
    dispute_resolution: {
      type: 'object',
      required: ['method'],
      properties: {
        method: {
          type: 'string',
          enum: [
            'automatic_escrow',
            'lockstep_verification',
            'timeout_release',
            'manual_arbitration',
          ],
          description: 'Dispute resolution method',
        },
        timeout_hours: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Timeout for dispute resolution in hours',
        },
        arbitrator: {
          type: 'string',
          description: 'DID of the arbitrator agent (for manual_arbitration)',
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

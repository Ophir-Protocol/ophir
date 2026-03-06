import { describe, it, expect, beforeEach } from 'vitest';
import { NettingEngine } from '../netting-engine.js';
import { OphirError, OphirErrorCode } from '@ophirai/protocol';
import type { Obligation } from '../types.js';

function makeObligation(id: string, from: string, to: string, amount: number): Obligation {
  return {
    id,
    from_agent: from,
    to_agent: to,
    amount,
    agreement_id: `agreement-${id}`,
    created_at: new Date().toISOString(),
  };
}

describe('NettingEngine', () => {
  let engine: NettingEngine;

  beforeEach(() => {
    engine = new NettingEngine();
  });

  it('adds and removes obligations correctly', () => {
    const ob1 = makeObligation('ob1', 'A', 'B', 100);
    const ob2 = makeObligation('ob2', 'B', 'C', 50);
    const ob3 = makeObligation('ob3', 'C', 'A', 75);

    engine.addObligation(ob1);
    engine.addObligation(ob2);
    engine.addObligation(ob3);

    const graph = engine.getObligationGraph();
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(3);

    engine.removeObligation('ob2');

    const graphAfter = engine.getObligationGraph();
    expect(graphAfter.edges).toHaveLength(2);
    const hasBC = graphAfter.edges.some(e => e.from === 'B' && e.to === 'C');
    expect(hasBC).toBe(false);
  });

  it('detects simple 2-node cycle', () => {
    engine.addObligation(makeObligation('ob1', 'A', 'B', 100));
    engine.addObligation(makeObligation('ob2', 'B', 'A', 80));

    const results = engine.runNetting();
    expect(results.length).toBeGreaterThanOrEqual(1);

    const graph = engine.getObligationGraph();
    // After netting $80: only A→B=$20 should remain
    const abEdge = graph.edges.find(e => e.from === 'A' && e.to === 'B');
    expect(abEdge).toBeDefined();
    expect(abEdge!.amount).toBe(20);

    const baEdge = graph.edges.find(e => e.from === 'B' && e.to === 'A');
    expect(baEdge).toBeUndefined();
  });

  it('detects 3-node cycle', () => {
    engine.addObligation(makeObligation('ob1', 'A', 'B', 10));
    engine.addObligation(makeObligation('ob2', 'B', 'C', 15));
    engine.addObligation(makeObligation('ob3', 'C', 'A', 8));

    const results = engine.runNetting();
    expect(results.length).toBeGreaterThanOrEqual(1);

    const graph = engine.getObligationGraph();
    const abEdge = graph.edges.find(e => e.from === 'A' && e.to === 'B');
    const bcEdge = graph.edges.find(e => e.from === 'B' && e.to === 'C');
    const caEdge = graph.edges.find(e => e.from === 'C' && e.to === 'A');

    // Min weight is 8, so subtract 8 from each edge
    expect(abEdge).toBeDefined();
    expect(abEdge!.amount).toBe(2);
    expect(bcEdge).toBeDefined();
    expect(bcEdge!.amount).toBe(7);
    expect(caEdge).toBeUndefined(); // 8 - 8 = 0, removed
  });

  it('handles no cycles gracefully', () => {
    engine.addObligation(makeObligation('ob1', 'A', 'B', 10));
    engine.addObligation(makeObligation('ob2', 'B', 'C', 10));

    const results = engine.runNetting();
    expect(results).toHaveLength(0);
  });

  it('nets multiple cycles', () => {
    // Cycle 1: A ↔ B
    engine.addObligation(makeObligation('ob1', 'A', 'B', 50));
    engine.addObligation(makeObligation('ob2', 'B', 'A', 30));

    // Cycle 2: C ↔ D
    engine.addObligation(makeObligation('ob3', 'C', 'D', 40));
    engine.addObligation(makeObligation('ob4', 'D', 'C', 25));

    const results = engine.runNetting();
    expect(results.length).toBeGreaterThanOrEqual(2);

    const graph = engine.getObligationGraph();
    const abEdge = graph.edges.find(e => e.from === 'A' && e.to === 'B');
    const cdEdge = graph.edges.find(e => e.from === 'C' && e.to === 'D');

    expect(abEdge).toBeDefined();
    expect(abEdge!.amount).toBe(20);
    expect(cdEdge).toBeDefined();
    expect(cdEdge!.amount).toBe(15);
  });

  it('getNetExposure calculates correctly', () => {
    engine.addObligation(makeObligation('ob1', 'A', 'B', 100));
    engine.addObligation(makeObligation('ob2', 'C', 'A', 60));

    const exposure = engine.getNetExposure('A');
    expect(exposure.agent_id).toBe('A');
    expect(exposure.total_owed).toBe(100);
    expect(exposure.total_owed_to).toBe(60);
    expect(exposure.net_exposure).toBe(40);
  });

  it('compression ratio is correct', () => {
    engine.addObligation(makeObligation('ob1', 'A', 'B', 100));
    engine.addObligation(makeObligation('ob2', 'B', 'A', 100));

    const results = engine.runNetting();
    expect(results.length).toBeGreaterThanOrEqual(1);

    const result = results[0];
    expect(result.total_gross).toBe(200);
    expect(result.total_net).toBe(0);
    expect(result.compression_ratio).toBe(1.0);

    const graph = engine.getObligationGraph();
    expect(graph.edges).toHaveLength(0);
  });

  it('handles large graph', () => {
    const agents = Array.from({ length: 10 }, (_, i) => `agent-${i}`);
    let obId = 0;

    // Create random obligations between agents
    for (let i = 0; i < agents.length; i++) {
      for (let j = 0; j < agents.length; j++) {
        if (i !== j && (i + j) % 3 === 0) {
          engine.addObligation(
            makeObligation(`ob-${obId++}`, agents[i], agents[j], (i + j + 1) * 10),
          );
        }
      }
    }

    // Should complete without error
    const results = engine.runNetting();
    expect(Array.isArray(results)).toBe(true);

    const graph = engine.getObligationGraph();
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
  });

  it('clear resets all state', () => {
    engine.addObligation(makeObligation('ob1', 'A', 'B', 100));
    engine.addObligation(makeObligation('ob2', 'B', 'A', 50));

    engine.clear();

    const graph = engine.getObligationGraph();
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);

    const results = engine.runNetting();
    expect(results).toHaveLength(0);
  });

  it('getObligationGraph returns correct structure', () => {
    engine.addObligation(makeObligation('ob1', 'A', 'B', 100));
    engine.addObligation(makeObligation('ob2', 'B', 'C', 50));
    engine.addObligation(makeObligation('ob3', 'C', 'A', 75));

    const graph = engine.getObligationGraph();

    expect(graph.nodes.sort()).toEqual(['A', 'B', 'C']);
    expect(graph.edges).toHaveLength(3);

    const abEdge = graph.edges.find(e => e.from === 'A' && e.to === 'B');
    const bcEdge = graph.edges.find(e => e.from === 'B' && e.to === 'C');
    const caEdge = graph.edges.find(e => e.from === 'C' && e.to === 'A');

    expect(abEdge).toBeDefined();
    expect(abEdge!.amount).toBe(100);
    expect(bcEdge).toBeDefined();
    expect(bcEdge!.amount).toBe(50);
    expect(caEdge).toBeDefined();
    expect(caEdge!.amount).toBe(75);
  });

  describe('input validation', () => {
    it('throws OphirError on non-positive obligation amount', () => {
      try {
        engine.addObligation(makeObligation('ob-bad', 'A', 'B', 0));
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OphirError);
        expect((e as OphirError).code).toBe(OphirErrorCode.NETTING_CYCLE_FAILED);
      }

      try {
        engine.addObligation(makeObligation('ob-neg', 'A', 'B', -50));
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OphirError);
        expect((e as OphirError).code).toBe(OphirErrorCode.NETTING_CYCLE_FAILED);
      }
    });

    it('throws OphirError on empty agent IDs', () => {
      try {
        engine.addObligation(makeObligation('ob-empty', '', 'B', 100));
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OphirError);
        expect((e as OphirError).code).toBe(OphirErrorCode.NETTING_CYCLE_FAILED);
      }
    });

    it('throws OphirError when from_agent equals to_agent', () => {
      try {
        engine.addObligation(makeObligation('ob-self', 'A', 'A', 100));
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OphirError);
        expect((e as OphirError).code).toBe(OphirErrorCode.NETTING_CYCLE_FAILED);
      }
    });

    it('removeObligation on unknown ID is a no-op', () => {
      engine.removeObligation('nonexistent');
      const graph = engine.getObligationGraph();
      expect(graph.nodes).toHaveLength(0);
      expect(graph.edges).toHaveLength(0);
    });
  });
});

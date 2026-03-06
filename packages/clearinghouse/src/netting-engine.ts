import { OphirError, OphirErrorCode } from '@ophirai/protocol';
import type { Obligation, NettingResult, AgentExposure } from './types.js';

export class NettingEngine {
  private obligations = new Map<string, Obligation>();
  private graph = new Map<string, Map<string, number>>();

  addObligation(obligation: Obligation): void {
    if (obligation.amount <= 0) {
      throw new OphirError(
        OphirErrorCode.NETTING_CYCLE_FAILED,
        `Obligation amount must be positive, got ${obligation.amount}`,
        { obligationId: obligation.id, amount: obligation.amount },
      );
    }
    if (!obligation.from_agent || !obligation.to_agent) {
      throw new OphirError(
        OphirErrorCode.NETTING_CYCLE_FAILED,
        'Obligation must have non-empty from_agent and to_agent',
        { obligationId: obligation.id },
      );
    }
    if (obligation.from_agent === obligation.to_agent) {
      throw new OphirError(
        OphirErrorCode.NETTING_CYCLE_FAILED,
        'Obligation from_agent and to_agent must be different',
        { obligationId: obligation.id, agent: obligation.from_agent },
      );
    }

    this.obligations.set(obligation.id, obligation);
    this.addEdge(obligation.from_agent, obligation.to_agent, obligation.amount);
  }

  removeObligation(id: string): void {
    const ob = this.obligations.get(id);
    if (!ob) return;
    this.obligations.delete(id);
    this.addEdge(ob.from_agent, ob.to_agent, -ob.amount);
  }

  findCycles(): string[][] {
    const cycles: string[][] = [];
    const nodes = Array.from(this.graph.keys());
    const visited = new Set<string>();
    const stack = new Set<string>();
    const path: string[] = [];

    const dfs = (node: string) => {
      visited.add(node);
      stack.add(node);
      path.push(node);

      const neighbors = this.graph.get(node);
      if (neighbors) {
        for (const [next, weight] of neighbors) {
          if (weight <= 0) continue;
          if (!visited.has(next)) {
            dfs(next);
          } else if (stack.has(next)) {
            const cycleStart = path.indexOf(next);
            const cycle = path.slice(cycleStart);
            cycle.push(next);
            cycles.push(cycle);
          }
        }
      }

      path.pop();
      stack.delete(node);
    };

    for (const node of nodes) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }

    return cycles;
  }

  netCycle(cycle: string[]): NettingResult | null {
    if (cycle.length < 3) return null;

    // Find minimum edge weight along the cycle
    let minWeight = Infinity;
    for (let i = 0; i < cycle.length - 1; i++) {
      const weight = this.getEdgeWeight(cycle[i], cycle[i + 1]);
      if (weight < minWeight) minWeight = weight;
    }

    if (minWeight <= 0) return null;

    // Subtract min from every edge in the cycle
    let totalGross = 0;
    for (let i = 0; i < cycle.length - 1; i++) {
      const edgeWeight = this.getEdgeWeight(cycle[i], cycle[i + 1]);
      totalGross += edgeWeight;
      const newWeight = edgeWeight - minWeight;
      this.setEdgeWeight(cycle[i], cycle[i + 1], newWeight);
      if (newWeight <= 0) {
        this.graph.get(cycle[i])!.delete(cycle[i + 1]);
      }
    }

    // Mark affected obligations as netted (proportionally reduce amounts)
    const affectedObligations: string[] = [];
    for (let i = 0; i < cycle.length - 1; i++) {
      const from = cycle[i];
      const to = cycle[i + 1];
      let remaining = minWeight;

      for (const [id, ob] of this.obligations) {
        if (ob.from_agent === from && ob.to_agent === to && remaining > 0) {
          const reduction = Math.min(ob.amount, remaining);
          ob.amount -= reduction;
          remaining -= reduction;
          affectedObligations.push(id);
          if (ob.amount <= 0) {
            this.obligations.delete(id);
          }
        }
      }
    }

    const agents = cycle.slice(0, -1);
    const totalNet = totalGross - minWeight * (cycle.length - 1);

    return {
      cycle_id: crypto.randomUUID(),
      obligations_netted: [...new Set(affectedObligations)],
      total_gross: totalGross,
      total_net: totalNet,
      compression_ratio: totalGross > 0 ? 1 - totalNet / totalGross : 0,
      agents_involved: agents,
      timestamp: new Date().toISOString(),
    };
  }

  runNetting(): NettingResult[] {
    const results: NettingResult[] = [];
    const MAX_ITERATIONS = 1000;
    let iterations = 0;

    let cycles = this.findCycles();
    while (cycles.length > 0) {
      if (++iterations > MAX_ITERATIONS) {
        throw new OphirError(
          OphirErrorCode.NETTING_CYCLE_FAILED,
          `Netting exceeded maximum ${MAX_ITERATIONS} iterations — possible degenerate graph`,
          { iterations, cyclesRemaining: cycles.length },
        );
      }

      // Sort by minimum edge weight (smallest first) for maximum cycle count
      cycles.sort((a, b) => this.cycleMinWeight(a) - this.cycleMinWeight(b));

      const cycle = cycles[0];
      const result = this.netCycle(cycle);
      if (!result) break;

      results.push(result);
      cycles = this.findCycles();
    }

    return results;
  }

  getNetExposure(agentId: string): AgentExposure {
    let totalOwed = 0;
    let totalOwedTo = 0;

    // Outgoing edges
    const outgoing = this.graph.get(agentId);
    if (outgoing) {
      for (const weight of outgoing.values()) {
        if (weight > 0) totalOwed += weight;
      }
    }

    // Incoming edges
    for (const [, neighbors] of this.graph) {
      const weight = neighbors.get(agentId);
      if (weight && weight > 0) totalOwedTo += weight;
    }

    return {
      agent_id: agentId,
      total_owed: totalOwed,
      total_owed_to: totalOwedTo,
      net_exposure: totalOwed - totalOwedTo,
      margin_held: 0,
      available_capacity: 0,
    };
  }

  getObligationGraph(): { nodes: string[]; edges: { from: string; to: string; amount: number }[] } {
    const nodes = new Set<string>();
    const edges: { from: string; to: string; amount: number }[] = [];

    for (const [from, neighbors] of this.graph) {
      nodes.add(from);
      for (const [to, amount] of neighbors) {
        if (amount > 0) {
          nodes.add(to);
          edges.push({ from, to, amount });
        }
      }
    }

    return { nodes: Array.from(nodes), edges };
  }

  clear(): void {
    this.obligations.clear();
    this.graph.clear();
  }

  private addEdge(from: string, to: string, amount: number): void {
    if (!this.graph.has(from)) this.graph.set(from, new Map());
    const neighbors = this.graph.get(from)!;
    neighbors.set(to, (neighbors.get(to) ?? 0) + amount);
    if (neighbors.get(to)! <= 0) {
      neighbors.delete(to);
    }
  }

  private getEdgeWeight(from: string, to: string): number {
    return this.graph.get(from)?.get(to) ?? 0;
  }

  private setEdgeWeight(from: string, to: string, weight: number): void {
    if (!this.graph.has(from)) this.graph.set(from, new Map());
    this.graph.get(from)!.set(to, weight);
  }

  private cycleMinWeight(cycle: string[]): number {
    let min = Infinity;
    for (let i = 0; i < cycle.length - 1; i++) {
      const w = this.getEdgeWeight(cycle[i], cycle[i + 1]);
      if (w < min) min = w;
    }
    return min;
  }
}

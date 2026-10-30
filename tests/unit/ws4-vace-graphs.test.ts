import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WS4 vace/wan-animate graph invariants:
 *  - every graph that contains WanVaceToVideo decodes the sampler through a
 *    TrimVideoLatent whose trim_amount comes from that node's output 3
 *    (the prepended reference latent must never reach VHS_VideoCombine -
 *    it added ~4 leading frames to motion-transfer runs)
 *  - every input link targets a node that exists in the graph
 *  - the _meta.requires block names every VHS_* class the graph uses
 */

const WF_DIR = resolve(__dirname, "../../workflows");
const files = readdirSync(WF_DIR).filter((f) => f.endsWith(".json"));

type Node = { class_type: string; inputs: Record<string, unknown> };
type Meta = { requires?: string[] };
type Graph = Record<string, Node | Meta | undefined>;

const isNode = (n: Node | Meta | undefined): n is Node =>
  !!n && typeof (n as Node).class_type === "string";
const nodeEntries = (graph: Graph): [string, Node][] =>
  Object.entries(graph).filter((e): e is [string, Node] => e[0] !== "_meta" && isNode(e[1]));
const meta = (graph: Graph): Meta => (graph._meta ?? {}) as Meta;

const graphs = files.map((file) => ({
  file,
  graph: JSON.parse(readFileSync(join(WF_DIR, file), "utf8")) as Graph,
}));
const vaceGraphs = graphs.filter(({ graph }) =>
  nodeEntries(graph).some(([, n]) => n.class_type === "WanVaceToVideo"));

describe("ws4: vace graphs trim the reference latent before decode", () => {
  it("found graphs with WanVaceToVideo", () => {
    expect(vaceGraphs.length).toBeGreaterThanOrEqual(4);
  });

  for (const { file, graph } of vaceGraphs) {
    it(`${file}: KSampler → TrimVideoLatent → VAEDecode`, () => {
      const vaceIds = nodeEntries(graph)
        .filter(([, n]) => n.class_type === "WanVaceToVideo").map(([id]) => id);
      const trims = nodeEntries(graph)
        .filter(([, n]) => n.class_type === "TrimVideoLatent");
      expect(trims.length, `${file} needs a TrimVideoLatent`).toBeGreaterThan(0);
      // the trim must be wired to the vace node's reference-latent count
      const wired = trims.some(([, n]) => {
        const src = n.inputs.trim_amount;
        return Array.isArray(src) && vaceIds.includes(String(src[0])) && src[1] === 3;
      });
      expect(wired, `${file}: trim_amount must read WanVaceToVideo output 3`).toBe(true);
      // and a VAEDecode must consume the trim's samples output
      const trimIds = new Set(trims.map(([tId]) => tId));
      const decodeThroughTrim = nodeEntries(graph).some(([, n]) => {
        if (n.class_type !== "VAEDecode") return false;
        const s = n.inputs.samples;
        return Array.isArray(s) && trimIds.has(String(s[0]));
      });
      expect(decodeThroughTrim, `${file}: VAEDecode must take the TrimVideoLatent output`).toBe(true);
    });
  }
});

describe("ws4: graph link integrity + requires", () => {
  for (const { file, graph } of graphs) {
    it(`${file}: every link targets an existing node`, () => {
      for (const [id, node] of nodeEntries(graph)) {
        for (const [input, v] of Object.entries(node.inputs)) {
          if (Array.isArray(v) && typeof v[0] === "string") {
            expect(graph[v[0]], `${file} node ${id}.${input} links missing node ${v[0]}`).toBeTruthy();
          }
        }
      }
    });

    // A8 scope: the vace-* / wan-animate-* graphs name every VHS class they use
    if (/^(vace-|wan-animate-)/.test(file)) {
      it(`${file}: requires names each VHS class used`, () => {
        const used = new Set(nodeEntries(graph)
          .map(([, n]) => n.class_type).filter((c) => c.startsWith("VHS_")));
        if (!used.size) return;
        const requires = (meta(graph).requires ?? []).join(" ");
        for (const cls of used) expect(requires, `${file} uses ${cls} - name it in requires`).toContain(cls);
      });
    }
  }
});

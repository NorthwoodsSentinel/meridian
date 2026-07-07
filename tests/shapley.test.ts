import { test, expect } from "bun:test";
import { shapleyValues } from "../src/value/shapley.ts";
import { additiveValue, quorumGatedValue, distributePayout } from "../src/value/coop.ts";

const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const sum = (o: Record<string, number>) => Object.values(o).reduce((s, x) => s + x, 0);

test("axiom: efficiency — Σ φ = v(N)", () => {
  const players = ["a", "b", "c"];
  const v = (S: string[]) => S.length * S.length; // non-additive
  const phi = shapleyValues(players, v);
  expect(approx(sum(phi), v(players))).toBe(true); // v(N) = 9
});

test("axiom: symmetry — interchangeable players get equal value", () => {
  const phi = shapleyValues(["a", "b", "c"], (S) => S.length * S.length);
  expect(approx(phi.a!, phi.b!)).toBe(true);
  expect(approx(phi.b!, phi.c!)).toBe(true);
  expect(approx(phi.a!, 3)).toBe(true); // 9 split three symmetric ways
});

test("axiom: null player — zero marginal everywhere → zero value", () => {
  // v counts only a and b; c never changes any coalition's value.
  const v = (S: string[]) => S.filter((p) => p === "a" || p === "b").length;
  const phi = shapleyValues(["a", "b", "c"], v);
  expect(approx(phi.c!, 0)).toBe(true);
  expect(approx(phi.a!, 1)).toBe(true);
  expect(approx(phi.b!, 1)).toBe(true);
});

test("additive game — Shapley = each member's own weight", () => {
  const contributors = [
    { memberId: "a", weight: 1 },
    { memberId: "b", weight: 2 },
    { memberId: "c", weight: 3 },
  ];
  const shares = distributePayout(60, contributors, additiveValue);
  const by = Object.fromEntries(shares.map((s) => [s.memberId, s.share]));
  expect(approx(by.a!, 10)).toBe(true);
  expect(approx(by.b!, 20)).toBe(true);
  expect(approx(by.c!, 30)).toBe(true);
});

test("efficiency of the payout split — Σ share = payout (both value functions)", () => {
  const contributors = [
    { memberId: "a", weight: 5 },
    { memberId: "b", weight: 1 },
    { memberId: "c", weight: 1 },
    { memberId: "d", weight: 1 },
  ];
  for (const fn of [additiveValue, quorumGatedValue(3)]) {
    const shares = distributePayout(1000, contributors, fn);
    const total = shares.reduce((s, x) => s + x.share, 0);
    expect(approx(total, 1000, 1e-6)).toBe(true);
  }
});

test("quorum-gated differs from additive — reaching critical mass carries value", () => {
  const contributors = [
    { memberId: "a", weight: 10 },
    { memberId: "b", weight: 1 },
    { memberId: "c", weight: 1 },
  ];
  const add = distributePayout(300, contributors, additiveValue);
  const quo = distributePayout(300, contributors, quorumGatedValue(2));
  const share = (arr: typeof add, id: string) => arr.find((s) => s.memberId === id)!.share;
  // additive gives the big contributor the lion's share strictly by weight...
  expect(share(add, "a")).toBeGreaterThan(share(quo, "a"));
  // ...quorum-gating lifts the small members who are needed to reach quorum.
  expect(share(quo, "b")).toBeGreaterThan(share(add, "b"));
});

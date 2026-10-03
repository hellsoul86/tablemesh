import type { Card } from './contracts.js';
const RANKS = '23456789TJQKA';
export function compareRanks(a: number[], b: number[]): number {
 for (let i = 0; i < Math.max(a.length, b.length); i++) {
  const difference = (a[i] ?? 0) - (b[i] ?? 0);
  if (difference) return difference;
 }
 return 0;
}
function five(cards: Card[]): number[] {
 const ranks = cards.map(c => RANKS.indexOf(c[0]!) + 2).sort((a, b) => b-a);
 const counts = new Map<number, number>();
 for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
 const groups = [...counts.entries()].sort((a,b) => b[1]-a[1] || b[0]-a[0]);
 const flush = cards.every(c => c[1] === cards[0]![1]);
 const unique = [...new Set(ranks)];
 const straight = unique.length === 5 && unique[0]! - unique[4]! === 4
  ? unique[0]! : unique.join(',') === '14,5,4,3,2' ? 5 : 0;
 if (flush && straight) return [8,straight];
 if (groups[0]![1] === 4) return [7,groups[0]![0],groups[1]![0]];
 if (groups[0]![1] === 3 && groups[1]![1] === 2) return [6,groups[0]![0],groups[1]![0]];
 if (flush) return [5,...ranks];
 if (straight) return [4,straight];
 if (groups[0]![1] === 3) return [3,groups[0]![0],...groups.slice(1).map(x => x[0])];
 if (groups[0]![1] === 2 && groups[1]![1] === 2) return [2,Math.max(groups[0]![0],groups[1]![0]),Math.min(groups[0]![0],groups[1]![0]),groups[2]![0]];
 if (groups[0]![1] === 2) return [1,groups[0]![0],...groups.slice(1).map(x => x[0])];
 return [0,...ranks];
}
/** Category 0..8 then descending kickers. Best five among 5..7 cards, suits never break ties. */
export function evaluateHand(cards: Card[]): number[] {
 if (cards.length < 5 || cards.length > 7 || new Set(cards).size !== cards.length || cards.some(c => !/^[2-9TJQKA][cdhs]$/.test(c)))
  throw new Error('Expected five to seven distinct canonical cards');
 let best: number[] = [];
 for (let a=0;a<cards.length-4;a++) for(let b=a+1;b<cards.length-3;b++)
 for(let c=b+1;c<cards.length-2;c++) for(let d=c+1;d<cards.length-1;d++)
 for(let e=d+1;e<cards.length;e++) {
  const value=five([cards[a]!,cards[b]!,cards[c]!,cards[d]!,cards[e]!]);
  if(compareRanks(value,best)>0) best=value;
 }
 return best;
}

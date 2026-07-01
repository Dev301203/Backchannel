/** Fun, readable pseudonymous handles: "swift-otter-4821". */
const ADJECTIVES = [
  'swift', 'quiet', 'lucky', 'brave', 'clever', 'mellow', 'nimble', 'sunny',
  'witty', 'cosmic', 'feral', 'gentle', 'jolly', 'keen', 'lively', 'plucky',
  'rowdy', 'snug', 'zesty', 'breezy', 'crisp', 'dusky', 'fuzzy', 'glossy',
];
const NOUNS = [
  'otter', 'falcon', 'maple', 'comet', 'pixel', 'ember', 'willow', 'badger',
  'lynx', 'harbor', 'meadow', 'quartz', 'raven', 'sparrow', 'thistle', 'walrus',
  'cactus', 'dolphin', 'gecko', 'heron', 'ibis', 'koala', 'lemur', 'narwhal',
];

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

export function randomHandle(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Math.floor(1000 + Math.random() * 9000)}`;
}

/** Handles a user may present as anonymous defaults that we should replace. */
export function isPlaceholderHandle(name: string | null | undefined): boolean {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  return n === '' || n === 'anonymous' || n === 'anon';
}

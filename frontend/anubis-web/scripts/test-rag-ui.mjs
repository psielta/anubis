/**
 * One-shot unit checks against the shipped pure helpers in rag-ui.ts.
 * Run: node --experimental-strip-types scripts/test-rag-ui.mjs
 * (Node 22+) or: npx tsx scripts/test-rag-ui.mjs
 */
import {
  canSubmitQuery,
  formatSourcePages,
  mapApiStatus,
  ragBadgeKind,
  ragStatusLabel,
  readerRagCommands,
  readerRagQueryParams,
  shouldContinuePolling,
  sourcePageTarget,
} from '../src/app/core/utils/rag-ui.ts';

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('ok:', msg);
  }
}

// mapApiStatus
assert(mapApiStatus(null, { notFound: true }) === 'not_indexed', '404 → not_indexed');
assert(mapApiStatus('pending') === 'pending', 'pending');
assert(mapApiStatus('processing') === 'processing', 'processing');
assert(mapApiStatus('completed') === 'completed', 'completed');
assert(mapApiStatus('failed') === 'failed', 'failed');
assert(mapApiStatus('weird') === 'unknown', 'unknown status');

// labels / badges
assert(ragStatusLabel('not_indexed') === 'Não indexado', 'label not_indexed');
assert(ragStatusLabel('processing', 42) === 'Processando 42%', 'label progress');
assert(ragStatusLabel('processing', 0) === 'Processando', 'label processing no %');
assert(ragStatusLabel('completed') === 'Pronto', 'label ready');
assert(ragBadgeKind('completed') === 'ready', 'badge ready');
assert(ragBadgeKind('failed') === 'error', 'badge error');
assert(ragBadgeKind('pending') === 'pending', 'badge pending');
assert(ragBadgeKind('not_indexed') === 'muted', 'badge muted');

// poll lifecycle
assert(shouldContinuePolling('pending') === true, 'poll pending');
assert(shouldContinuePolling('processing') === true, 'poll processing');
assert(shouldContinuePolling('completed') === false, 'stop completed');
assert(shouldContinuePolling('failed') === false, 'stop failed');
assert(shouldContinuePolling('not_indexed') === false, 'stop not_indexed');

// query gate
assert(canSubmitQuery('completed') === true, 'can query when ready');
assert(canSubmitQuery('processing') === false, 'no query while processing');

// sources → page
assert(sourcePageTarget(3, 5) === 3, 'prefer page_start');
assert(sourcePageTarget(null, 7) === 7, 'fallback page_end');
assert(sourcePageTarget(null, null) === null, 'null pages');
assert(formatSourcePages(1, 1) === 'Página 1', 'single page');
assert(formatSourcePages(2, 4) === 'Páginas 2–4', 'page range');
assert(formatSourcePages(null, null) === 'Página desconhecida', 'unknown page label');

// reader deep-link shaping
assert(
  JSON.stringify(readerRagCommands(12)) === JSON.stringify(['/read', 12]),
  'reader commands',
);
assert(
  JSON.stringify(readerRagQueryParams({ page: 9, openRag: true })) ===
    JSON.stringify({ rag: '1', page: '9' }),
  'reader query params',
);
assert(
  JSON.stringify(readerRagQueryParams({ openRag: true })) === JSON.stringify({ rag: '1' }),
  'open rag only',
);

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll rag-ui helper assertions passed.');

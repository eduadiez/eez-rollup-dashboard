# Quote trace viewer source

Verbatim assets from [eez-association/eez-rollupX at e5e10f0d40588cc0a4f3e4d0fbfc8bec2486bc05](https://github.com/eez-association/eez-rollupX/tree/e5e10f0d40588cc0a4f3e4d0fbfc8bec2486bc05/tools/quote-trace-viewer).
The example contains public fixture accounts and synthetic local state.

Update through `node scripts/sync-quote-trace-viewer.mjs /path/to/rollupX`;
the script copies the source checkout's committed HEAD. Change the upstream
viewer first instead of maintaining a second implementation here.
Then run `npm run test:debug` before committing the updated assets.

# Quote trace viewer source

Verbatim assets from [eez-association/eez-rollupX at 353be39dd369fe4da1935796dcc23cd729f81398](https://github.com/eez-association/eez-rollupX/tree/353be39dd369fe4da1935796dcc23cd729f81398/tools/quote-trace-viewer).
The example contains public fixture accounts and synthetic local state.

Update through `node scripts/sync-quote-trace-viewer.mjs /path/to/rollupX`;
the script copies the source checkout's committed HEAD. Change the upstream
viewer first instead of maintaining a second implementation here.
Then run `npm run test:debug` before committing the updated assets.

import { context, build } from 'esbuild'

const watch = process.argv.includes('--watch')
const opts = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  target: ['es2018'],
  outfile: 'dist/sdk.js',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  loader: { '.css': 'text' },
  logLevel: 'info',
}

if (watch) {
  const ctx = await context(opts)
  await ctx.watch()
}
else {
  await build(opts)
}

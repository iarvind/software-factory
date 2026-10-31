# factory-demo

A tiny Node service with no dependencies, for the software factory to practise on.

- `npm test` runs the tests in `test/` with `node --test`.
- `npm start` serves `/` (a greeting) and `/slug?text=…` on :4848.

Conventions: ES modules, plain Node, no dependencies, every function in `lib.js` has a test.

import { readFileSync } from 'node:fs';
const RealDate = Date;
const now = () => Number(readFileSync(process.env.SUB2SUB_TEST_CLOCK, 'utf8'));
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now()])); }
  static now() { return now(); }
};

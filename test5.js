'use strict';
const obj = {};
Object.defineProperty(obj, 'fetch', {
  get: () => 1,
  set: (v) => {},
  configurable: true
});
Object.defineProperty(obj, 'fetch', {
  get: () => 2,
  set: undefined
});
try {
  obj.fetch = 3;
  console.log('Success');
} catch (e) {
  console.log(e.message);
}

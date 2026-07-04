'use strict';
const obj = {};
Object.defineProperty(obj, 'fetch', {
  value: 1,
  writable: true,
  configurable: true
});
Object.defineProperty(obj, 'fetch', {
  get: () => 2
});
try {
  obj.fetch = 3;
  console.log('Success');
} catch (e) {
  console.log(e.message);
}

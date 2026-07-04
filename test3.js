'use strict';
const WindowPrototype = {};
Object.defineProperty(WindowPrototype, 'fetch', {
  get: () => 1,
  configurable: true
});
const windowObj = Object.create(WindowPrototype);

Object.defineProperty(windowObj, 'fetch', {
  value: windowObj.fetch,
  writable: true,
  configurable: true
});

windowObj.fetch = 2; // Should not throw!
console.log(windowObj.fetch);

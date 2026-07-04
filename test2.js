'use strict';
Object.defineProperty(global, 'fetch', { get: () => 1, configurable: true });
global.fetch = 2;

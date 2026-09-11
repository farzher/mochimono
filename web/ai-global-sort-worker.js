await import('./ai-global-sort-worker-core.js');

const handleMessage = self.onmessage;

self.onmessage = async event => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'count');
  Object.defineProperty(Object.prototype, 'count', {
    configurable:true,
    get() {
      if (this?.available && typeof this.available.length === 'number' && this?.data && Number.isFinite(Number(this?.dim))) {
        return this.available.length;
      }
      return undefined;
    }
  });
  try {
    return await handleMessage.call(self, event);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'count', previous);
    else delete Object.prototype.count;
  }
};

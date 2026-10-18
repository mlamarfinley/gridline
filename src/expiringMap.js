// Bounded process-local caches; disk/provider freshness policies still apply independently.
export class ExpiringMap extends Map {
  constructor(ttlMs=30*60e3, now=Date.now){super();this.ttlMs=ttlMs;this.now=now;this.times=new Map();}
  set(key,value){this.times.set(key,this.now());return super.set(key,value);}
  has(key){if(super.has(key)&&this.now()-this.times.get(key)>=this.ttlMs)this.delete(key);return super.has(key);}
  get(key){return this.has(key)?super.get(key):undefined;}
  delete(key){this.times.delete(key);return super.delete(key);}
  clear(){this.times.clear();super.clear();}
}

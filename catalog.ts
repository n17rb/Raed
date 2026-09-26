'use client';

import { useEffect, useState } from 'react';
import { A, api } from './api';
import type { Category, Items, Make } from './types';

let categoriesCache: Promise<Category[]> | null = null;
let makesCache: Promise<Make[]> | null = null;

export function invalidateCatalogCache(): void {
  categoriesCache = null;
  makesCache = null;
}

export function loadCategories(): Promise<Category[]> {
  if (!categoriesCache) {
    categoriesCache = api.get<Items<Category>>(`${A}/categories`).then((result) => result.items);
    categoriesCache.catch(() => {
      categoriesCache = null;
    });
  }
  return categoriesCache;
}

export function loadMakes(): Promise<Make[]> {
  if (!makesCache) {
    makesCache = api.get<Items<Make>>(`${A}/catalog/makes`).then((result) => result.items);
    makesCache.catch(() => {
      makesCache = null;
    });
  }
  return makesCache;
}

export function useCategories(enabled = true): Category[] {
  const [items, setItems] = useState<Category[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadCategories()
      .then((list) => alive && setItems(list))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled]);
  return items;
}

export function useMakes(enabled = true): Make[] {
  const [items, setItems] = useState<Make[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadMakes()
      .then((list) => alive && setItems(list))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled]);
  return items;
}

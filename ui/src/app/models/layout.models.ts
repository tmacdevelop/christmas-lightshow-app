export interface Point {
  x: number;
  y: number;
}

/**
 * Discriminated union of geometries. Phase 3 only ships `strip` (a straight
 * line of evenly spaced pixels), but new variants slot in as additional
 * `type` values.
 */
export type Geometry = StripGeometry;

export interface StripGeometry {
  type: 'strip';
  start: Point;
  end: Point;
}

export interface Prop {
  id: string;
  name: string;
  pixel_offset: number;
  pixel_count: number;
  geometry: Geometry;
}

export interface Layout {
  id: string;
  name: string;
  width: number;
  height: number;
  props: Prop[];
}

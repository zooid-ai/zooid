import { XMLBuilder } from 'fast-xml-parser';

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  suppressEmptyNode: true,
  processEntities: false,
});

export function buildXml(obj: Record<string, unknown>): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(obj);
}

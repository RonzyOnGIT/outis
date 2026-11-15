import { describe, expect, it } from 'vitest';
import { anonymize, detectKnownValues, detectRules, resolveSpans, Vault, type DetectOptions } from '../src/index.js';

function clean(text: string, options: DetectOptions = {}): string {
  return anonymize(text, resolveSpans(text, detectRules(text), options), new Vault()).text;
}

describe('explicit financial and vehicle identifiers', () => {
  it.each([
    ['routing\nnumber 271828184', '271828184'],
    ['Routing number\n271828184', '271828184'],
    ['ACH routing: 000123456', '000123456'],
    ['Bank routing number is 271828184', '271828184'],
    ['Routing transit number: 271 828 184', '271 828 184'],
    ['ABA number: 271-828-184', '271-828-184'],
    ['RTN: 271828184', '271828184'],
    ['Routing number: 271\n828\n184', '271\n828\n184'],
    ['{"routingNumber":"271828184"}', '271828184'],
    ['{"routing_number":"271828184"}', '271828184'],
    ['Texas license plate KTR-7293.', 'KTR-7293'],
    ['Licence\nplate: KTR-7293.', 'KTR-7293'],
    ['License plate\nKTR-7293', 'KTR-7293'],
    ['License plate: 7ABC123', '7ABC123'],
    ['Number plate: AB12 CDE', 'AB12 CDE'],
    ['License plate: ABC 1234', 'ABC 1234'],
    ['Vehicle registration number: AB-123-CD', 'AB-123-CD'],
    ['License plate: FREEDOM', 'FREEDOM'],
    ['Licence plate: freedom', 'freedom'],
    ['License plate number: A7', 'A7'],
    ['VIN: 1HGCM82633A004352', '1HGCM82633A004352'],
    ['Lease No. LS-2028-58312', 'LS-2028-58312'],
    ['Contract\nnumber\nCN-58312', 'CN-58312'],
  ])('hides the complete value: %s', (text, value) => {
    expect(clean(text)).toBe(text.replace(value, '[ID_1]'));
  });

  it.each([
    ['Routing number,Amount\n271828184,12500', 'Routing number,Amount\n[ID_1],12500'],
    ['Amount\tRouting number\n12500\t271828184', 'Amount\tRouting number\n12500\t[ID_1]'],
    ['License plate,Year\nKTR-7293,2019\nFREEDOM,2020', 'License plate,Year\n[ID_1],2019\n[ID_2],2020'],
    ['| License plate | Fee |\n| --- | --- |\n| A7 | 250 |', '| License plate | Fee |\n| --- | --- |\n| [ID_1] | 250 |'],
    ['{"amount":12500,"routingNumber":"271828184","licensePlate":"KTR-7293"}', '{"amount":12500,"routingNumber":"[ID_1]","licensePlate":"[ID_2]"}'],
    ['License plate: 2028-04\nDeadline: 2028-04-01', 'License plate: [ID_1]\nDeadline: 2028-04-01'],
  ])('keeps explicit ID fields separate from nearby useful values: %s', (text, expected) => {
    expect(clean(text)).toBe(expected);
  });

  it('hides identifiers in wrapped lease prose without removing rent, deadlines, model years or notice periods', () => {
    const text = "Lease No. LS-2028-58312\nMonthly rent $1,450.00 is paid by ACH from Tenant's account at Example Credit Union, routing\nnumber 271828184, account number 0098765432. The lease begins July 1, 2028.\nTenant's registered vehicle is a\n2019 Honda Civic, Texas license plate KTR-7293. Guests may stay 7 days.\nLease No. LS-2028-58312";
    expect(clean(text)).toBe("Lease No. [ID_1]\nMonthly rent $1,450.00 is paid by ACH from Tenant's account at Example Credit Union, routing\nnumber [ID_2], account number [ID_3]. The lease begins July 1, 2028.\nTenant's registered vehicle is a\n2019 Honda Civic, Texas license plate [ID_4]. Guests may stay 7 days.\nLease No. [ID_1]");
  });

  it.each([
    'The license plate renewal fee is $75. The lease lasts 12 months.',
    'LICENSE PLATE RENEWAL costs 75 dollars.',
    'The routing algorithm processed 271828184 requests.',
    'Compare routing performance with 12500 items.',
    'License plate formats vary by state. Vehicle registration expires in 2028.',
    'A 2019 Honda Civic; rent $1450; deadline July 1, 2028; notice 30 days.',
  ])('preserves general descriptions, costs and quantities: %s', (text) => {
    expect(clean(text)).toBe(text);
  });

  it('does not relax a routing field merely because a previous column contains a balance', () => {
    const text = 'Balance\tRouting number\n12500\t271828184';
    const candidates = detectKnownValues(text, [{ value: '271828184', type: 'ID' }]);
    const result = anonymize(text, resolveSpans(text, candidates), new Vault()).text;
    expect(result).toBe('Balance\tRouting number\n12500\t[ID_1]');
  });
  it('does not replace a remembered ID inside a longer unrelated calendar date', () => {
    const text = 'Deadline: 2028-04-01';
    expect(detectKnownValues(text, [{ value: '2028-04', type: 'ID' }])).toEqual([]);
  });

  it('retains the existing explicit user overrides', () => {
    const text = 'Routing number: 271828184';
    expect(clean(text, { neverHide: ['271828184'] })).toBe(text);
    expect(clean(text, { policy: { ID: false } })).toBe(text);
  });
});

describe('complete street addresses', () => {
  it('includes single-letter directions, unit details and a wrapped city/ZIP', () => {
    const text = 'Landlord: Example Company, 1200 W Oak St, Suite 300,\nArlington, TX 76013';
    expect(clean(text)).toBe('Landlord: Example Company, [ADDRESS_1]');
  });
});

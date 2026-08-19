import { describe, expect, it } from 'vitest';
import { parseContactCsv, parseTagCell } from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: true,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
        },
      ],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
        },
      ],
    });
  });

  it('matches First/Last Name and a non-"phone" phone column (real lead-export header shape)', () => {
    // Mirrors a real client lead export: separate first/last name columns,
    // and the phone number living in "Other Phone 1" with Home/Mobile/Work
    // present but blank.
    const csv = `First Name,Last Name,Email,Home,Mobile,Work,Other Phone 1
Tara,Wooding,woodingtara@yahoo.com,,,,9199046874
Reginald,Blakeney,blakeney1914@gmail.com,,,,7577755991`;

    const result = parseContactCsv(csv);
    expect(result.rows).toEqual([
      {
        phone: '9199046874',
        name: 'Tara Wooding',
        email: 'woodingtara@yahoo.com',
        company: undefined,
        tagNames: [],
      },
      {
        phone: '7577755991',
        name: 'Reginald Blakeney',
        email: 'blakeney1914@gmail.com',
        company: undefined,
        tagNames: [],
      },
    ]);
  });

  it('prefers Mobile over a blank Home when both are present', () => {
    const csv = `Name,Home,Mobile
Alice,,+15551234567`;

    expect(parseContactCsv(csv).rows).toEqual([
      { phone: '+15551234567', name: 'Alice', email: undefined, company: undefined, tagNames: [] },
    ]);
  });

  it('still returns empty when no phone-like column exists at all', () => {
    const csv = `Name,Email
Alice,alice@example.com`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      rows: [],
    });
  });
});

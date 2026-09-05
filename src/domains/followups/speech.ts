const small = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function spokenInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Expected a nonnegative safe integer');
  if (value < 20) return small[value] ?? '';
  if (value < 100)
    return `${tens[Math.floor(value / 10)]}${value % 10 ? `-${spokenInteger(value % 10)}` : ''}`;
  for (const [scale, label] of [
    [10_000_000, 'crore'],
    [100_000, 'lakh'],
    [1_000, 'thousand'],
    [100, 'hundred'],
  ] as const) {
    if (value >= scale)
      return `${spokenInteger(Math.floor(value / scale))} ${label}${value % scale ? ` ${spokenInteger(value % scale)}` : ''}`;
  }
  return '';
}

export function spokenMoney(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new Error('Expected integer paise');
  return `${spokenInteger(Math.floor(paise / 100))} rupees${paise % 100 ? ` and ${spokenInteger(paise % 100)} paise` : ''} per kilogram`;
}

export function spokenRequirement(code: string): string {
  return code
    .split('-')
    .map((part) =>
      /^\d+$/.test(part)
        ? [...part].map((digit) => small[Number(digit)]).join(' ')
        : part === 'DEMO'
          ? 'Demo'
          : /^[A-Z]{1,4}$/.test(part)
            ? [...part].join(' ')
            : part,
    )
    .join(', ');
}

export function spokenSpecification(value: string): string {
  return value
    .replace(/\bEN(\d+)\b/g, (_, n: string) => `E N ${spokenInteger(Number(n))}`)
    .replace(/\bM(\d+)\b/g, (_, n: string) => `M ${spokenInteger(Number(n))}`)
    .replace(/\s[x×]\s/g, ' by ')
    .replace(/\bmm\b/g, 'millimetres')
    .replace(/\b(KG|GST|MS|GI|IS|RFQ|LLP)\b/g, (word) =>
      word === 'KG' ? 'kilograms' : [...word].join(' '),
    )
    .replace(/\b\d+(?:\.\d+)?\b/g, (number) => {
      const [whole = '0', decimal] = number.split('.');
      return `${spokenInteger(Number(whole))}${decimal ? ` point ${[...decimal].map((digit) => small[Number(digit)]).join(' ')}` : ''}`;
    });
}

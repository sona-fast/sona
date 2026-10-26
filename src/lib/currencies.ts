/**
 * The commission form's currency picker: which currencies its short row offers
 * and which one a form opens on. Client-safe, so the server load and the
 * picker read the same rules (SONA-236).
 *
 * The browser's language tags say where the owner is (Accept-Language on the
 * server, the same list the browser keeps in navigator.languages). Intl names
 * currencies but can't map a region to its currency, so that table lives here.
 */

/** The row with no saved prices and no region to go on. */
const FALLBACK_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY'] as const;

/** How many currencies the row shows before Other currency. */
export const CURRENCY_ROW_MAX = 4;

/** Every currency code this engine can name. Intl.NumberFormat accepts any
 * well-formed code (ZZZ included), so it can't answer "is this a currency". */
export function knownCurrencies(): string[] {
	try {
		return Intl.supportedValuesOf('currency');
	} catch {
		return [...FALLBACK_CURRENCIES];
	}
}

/** The no-JS row's Other currency radio: with it picked, the server reads the
 * code from the Other currency select (`currencyOther`) instead. */
export const CURRENCY_OTHER = '__other';

/** The symbol a currency prints with in `locale`, or null when it has none of
 * its own: the locale prints the code (CHF), or the code isn't a currency.
 * Callers show the code beside it, so a null keeps them from saying it twice. */
export function currencySymbol(
	code: string,
	locale: string,
	display: 'narrowSymbol' | 'symbol' = 'narrowSymbol'
): string | null {
	try {
		const symbol = new Intl.NumberFormat(locale, { style: 'currency', currency: code, currencyDisplay: display })
			.formatToParts(0)
			.find((p) => p.type === 'currency')?.value;
		return symbol && symbol !== code.toUpperCase() ? symbol : null;
	} catch {
		return null;
	}
}

let known: Set<string> | null = null;
function isKnownCurrency(code: string): boolean {
	known ??= new Set(knownCurrencies());
	return known.has(code);
}

// ISO 3166-1 region → the ISO 4217 currency people price in there. Regions
// whose currency this engine doesn't know are skipped at lookup.
const REGION_CURRENCY: Record<string, string> = Object.fromEntries(
	(
		'AD:EUR AE:AED AF:AFN AG:XCD AI:XCD AL:ALL AM:AMD AO:AOA AR:ARS AS:USD AT:EUR AU:AUD AW:AWG ' +
		'AX:EUR AZ:AZN BA:BAM BB:BBD BD:BDT BE:EUR BF:XOF BG:EUR BH:BHD BI:BIF BJ:XOF BL:EUR BM:BMD ' +
		'BN:BND BO:BOB BQ:USD BR:BRL BS:BSD BT:BTN BW:BWP BY:BYN BZ:BZD CA:CAD CC:AUD CD:CDF CF:XAF ' +
		'CG:XAF CH:CHF CI:XOF CK:NZD CL:CLP CM:XAF CN:CNY CO:COP CR:CRC CU:CUP CV:CVE CW:ANG CX:AUD ' +
		'CY:EUR CZ:CZK DE:EUR DJ:DJF DK:DKK DM:XCD DO:DOP DZ:DZD EC:USD EE:EUR EG:EGP EH:MAD ER:ERN ' +
		'ES:EUR ET:ETB FI:EUR FJ:FJD FK:FKP FM:USD FO:DKK FR:EUR GA:XAF GB:GBP GD:XCD GE:GEL GF:EUR ' +
		'GG:GBP GH:GHS GI:GIP GL:DKK GM:GMD GN:GNF GP:EUR GQ:XAF GR:EUR GT:GTQ GU:USD GW:XOF GY:GYD ' +
		'HK:HKD HN:HNL HR:EUR HT:HTG HU:HUF ID:IDR IE:EUR IL:ILS IM:GBP IN:INR IO:USD IQ:IQD IR:IRR ' +
		'IS:ISK IT:EUR JE:GBP JM:JMD JO:JOD JP:JPY KE:KES KG:KGS KH:KHR KI:AUD KM:KMF KN:XCD KP:KPW ' +
		'KR:KRW KW:KWD KY:KYD KZ:KZT LA:LAK LB:LBP LC:XCD LI:CHF LK:LKR LR:LRD LS:LSL LT:EUR LU:EUR ' +
		'LV:EUR LY:LYD MA:MAD MC:EUR MD:MDL ME:EUR MF:EUR MG:MGA MH:USD MK:MKD ML:XOF MM:MMK MN:MNT ' +
		'MO:MOP MP:USD MQ:EUR MR:MRU MS:XCD MT:EUR MU:MUR MV:MVR MW:MWK MX:MXN MY:MYR MZ:MZN NA:NAD ' +
		'NC:XPF NE:XOF NF:AUD NG:NGN NI:NIO NL:EUR NO:NOK NP:NPR NR:AUD NU:NZD NZ:NZD OM:OMR PA:USD ' +
		'PE:PEN PF:XPF PG:PGK PH:PHP PK:PKR PL:PLN PM:EUR PN:NZD PR:USD PS:ILS PT:EUR PW:USD PY:PYG ' +
		'QA:QAR RE:EUR RO:RON RS:RSD RU:RUB RW:RWF SA:SAR SB:SBD SC:SCR SD:SDG SE:SEK SG:SGD SH:SHP ' +
		'SI:EUR SJ:NOK SK:EUR SL:SLE SM:EUR SN:XOF SO:SOS SR:SRD SS:SSP ST:STN SV:USD SX:ANG SY:SYP ' +
		'SZ:SZL TC:USD TD:XAF TF:EUR TG:XOF TH:THB TJ:TJS TK:NZD TL:USD TM:TMT TN:TND TO:TOP TR:TRY ' +
		'TT:TTD TV:AUD TW:TWD TZ:TZS UA:UAH UG:UGX UM:USD US:USD UY:UYU UZ:UZS VA:EUR VC:XCD VE:VES ' +
		'VG:USD VI:USD VN:VND VU:VUV WF:XPF WS:WST XK:EUR YE:YER YT:EUR ZA:ZAR ZM:ZMW ZW:ZWG'
	)
		.split(' ')
		.map((pair) => pair.split(':') as [string, string])
);

/** The currency of the first tag in the owner's first language that names a
 * region, or null when none does ("en" alone says nothing about where the
 * owner is). A later tag in another language is a fallback the owner reads,
 * not where they are: "ja,en-US" gives null, not USD. Takes an
 * Accept-Language header; quality values keep their order. */
export function localeCurrency(languages: string | null | undefined): string | null {
	if (!languages) return null;
	const tags = languages
		.split(',')
		.map((part) => part.split(';')[0].trim())
		.filter(Boolean);
	let language: string | undefined;
	for (const tag of tags) {
		let locale: Intl.Locale;
		try {
			locale = new Intl.Locale(tag);
		} catch {
			if (language === undefined) return null;
			continue;
		}
		language ??= locale.language;
		if (locale.language !== language) continue;
		const region = locale.region;
		if (!region) continue;
		const currency = REGION_CURRENCY[region.toUpperCase()];
		if (currency && isKnownCurrency(currency)) return currency;
	}
	return null;
}

/**
 * The picker's short row. The entry's own currency comes first, even when the
 * owner rarely uses it. Then the currencies of saved entries, most recently
 * used first. With nothing saved yet, the owner's regional currency leads the
 * common fallbacks.
 */
export function currencyRow(opts: {
	entryCurrency?: string | null;
	recent: readonly string[];
	localeCurrency: string | null;
}): string[] {
	const row: string[] = [];
	const add = (code: string | null | undefined) => {
		if (code && !row.includes(code) && isKnownCurrency(code)) row.push(code);
	};
	// The entry's own code shows even if this engine doesn't list it: an older
	// entry may hold any code the text field took, and editing must not drop it.
	if (opts.entryCurrency) row.push(opts.entryCurrency);
	if (opts.recent.length > 0) for (const code of opts.recent) add(code);
	else {
		add(opts.localeCurrency);
		for (const code of FALLBACK_CURRENCIES) add(code);
	}
	return row.slice(0, CURRENCY_ROW_MAX);
}

/** The currency a new form opens on: the most recently used, else the
 * regional one. Empty when there's nothing to go on, so nothing is picked
 * until the owner picks. */
export function initialCurrency(opts: { recent: readonly string[]; localeCurrency: string | null }): string {
	return opts.recent[0] || opts.localeCurrency || '';
}

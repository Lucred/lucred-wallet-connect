import { rpc, Contract, TransactionBuilder, Networks, scValToNative, nativeToScVal, Account, Keypair, xdr } from '@stellar/stellar-sdk';
import { ProtocolInfo } from './registry';

/**
 * Live, runtime discovery of pool/pair/vault addresses that a factory
 * deploys dynamically - the same problem DefiLlama's own TVL adapters solve
 * per protocol (see the specific references in each function below). A
 * static list in registry.ts goes stale the moment a new pool launches;
 * calling these at indexer startup (see indexer.ts) doesn't.
 *
 * Verified against real mainnet data as of 2026-09-20:
 * - Soroswap: 214 real pairs exist via all_pairs_length/all_pairs.
 * - Sushi Stellar: pool_created events exist on the real factory.
 * - DeFindex: has a real on-chain factory (see discoverDeFindexVaults below)
 *   that enumerates every vault ever deployed - their own discover API and
 *   this file's old static registry fallback together covered only 23 of
 *   117 real vaults (confirmed 2026-09-30).
 */

const RPC_URL = 'https://mainnet.sorobanrpc.com';
const STELLAR_EXPERT = 'https://api.stellar.expert/explorer/public';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for a rate-limit/server-side error worth retrying, false for a real
 * simulation failure (bad method name, contract reverted, ...) that would
 * just fail identically on retry. Soroban RPC's HTTP client wraps a 429/5xx
 * in an error whose message contains the status text (confirmed directly:
 * mainnet.sorobanrpc.com's Cloudflare front-end returns a 429 with "Too Many
 * Requests" in the body during a burst of calls - see the next comment for
 * why that burst is easy to trigger here specifically). */
function isTransientRpcError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /429|too many requests|5\d\d|rate.?limit/i.test(message);
}

/**
 * Read-only contract call via Soroban RPC simulation. Uses a freshly
 * generated, never-funded keypair as the transaction source - confirmed
 * against real mainnet data that simulateTransaction neither requires nor
 * checks that the source account exists on-ledger, so this has no
 * dependency on any specific real account's continued existence (unlike an
 * earlier version of this research that hardcoded one and it later 404'd).
 *
 * Retries transient (429/5xx) failures with backoff - confirmed necessary
 * live: mainnet.sorobanrpc.com sits behind Cloudflare rate-limiting, and
 * discoverSoroswapPairs (the only caller that loops this many times) makes
 * ~215 of these calls back-to-back to enumerate every pair. Before this,
 * ANY single 429 mid-loop threw and discoverAllDynamicPools's per-source
 * catch discarded the *entire* partial result - not a graceful
 * degradation, a real outage: an indexer restart during any rate-limited
 * window started with Soroswap (Stellar's highest-volume tracked protocol
 * by pair count) completely missing from the registry, silently, for that
 * process's entire lifetime, since discovery only runs once at startup.
 *
 * STRENGTHENED 2026-10-01: the original 5-attempt/linear-backoff version
 * (max ~7.5s of total retry wait) turned out to be nowhere near enough in
 * practice - confirmed on real mainnet logs across every indexer shard in
 * the fleet (~17 containers, multiple per VM, all independently running
 * this same discovery on overlapping schedules against ONE shared public
 * RPC host): DeFindex discovery (118 sequential calls) was failing with
 * 429s on essentially EVERY startup and EVERY periodic refresh, on EVERY
 * shard checked, not as an occasional blip. The real cause is a
 * thundering-herd effect this function alone can't fully fix (several
 * containers sharing one VM's outbound IP all hammer the same endpoint at
 * once, so one container backing off doesn't stop its neighbors from
 * keeping the rate limiter tripped) - but a much longer, exponential,
 * jittered retry budget (up to ~2 minutes of total wait versus ~7.5s)
 * gives a stuck call a real chance to land in a gap between other
 * containers' bursts, instead of giving up almost immediately. Jitter
 * (±30%) is specifically to stop multiple containers that got
 * rate-limited by the SAME burst from retrying in lockstep and
 * re-colliding on their very next attempt.
 */
async function simulateReadOnlyCall(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
  maxAttempts = 9
): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const account = new Account(Keypair.random().publicKey(), '0');
      const contract = new Contract(contractId);
      const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: Networks.PUBLIC })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`${method}() on ${contractId} failed: ${sim.error}`);
      }
      if (!sim.result) {
        throw new Error(`${method}() on ${contractId} returned no result (may need state restore)`);
      }
      return scValToNative(sim.result.retval);
    } catch (err) {
      lastErr = err;
      if (!isTransientRpcError(err) || attempt === maxAttempts) throw err;
      // Exponential backoff (1s, 2s, 4s, 8s, 16s, 30s cap) with ±30% jitter,
      // not the old flat 500ms*attempt - a sustained multi-container
      // rate-limit window needs real wall-clock time to clear, and jitter
      // keeps containers that got limited by the same burst from retrying
      // in lockstep and re-colliding.
      const base = Math.min(1000 * 2 ** (attempt - 1), 30000);
      const jitter = base * 0.3 * (Math.random() * 2 - 1);
      await sleep(Math.round(base + jitter));
    }
  }
  throw lastErr;
}

/**
 * Soroswap pools are Uniswap-V2-style pairs, individually deployed by the
 * factory - confirmed real (swap/sync events with correct topic/data shape)
 * against 5 real pair addresses pulled this way. Mirrors DefiLlama's own
 * enumeration method: https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/soroswap/index.js
 *
 * A small delay between calls (not just retry-after-the-fact) - this loop
 * is what makes Soroswap discovery uniquely likely to get rate-limited in
 * the first place: ~215 sequential simulateTransaction calls to the same
 * RPC host with no pacing at all, versus Sushi/DeFindex's much smaller
 * request counts. Spacing calls out trades a few extra seconds of startup
 * time for not tripping the limiter to begin with, rather than relying
 * purely on retry-after-the-fact to recover from it every time.
 */
export async function discoverSoroswapPairs(
  factoryId = 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2'
): Promise<Record<string, ProtocolInfo>> {
  const server = new rpc.Server(RPC_URL);
  const pairCount = Number(await simulateReadOnlyCall(server, factoryId, 'all_pairs_length'));

  const result: Record<string, ProtocolInfo> = {};
  for (let i = 0; i < pairCount; i++) {
    if (i > 0) await sleep(75);
    const pair = (await simulateReadOnlyCall(server, factoryId, 'all_pairs', [
      nativeToScVal(i, { type: 'u32' })
    ])) as string;
    result[pair] = { protocolName: 'soroswap', category: 'amm_pair' };
  }
  return result;
}

/** Fetches every event a contract ever emitted matching a given topic[0],
 * paginating through stellar.expert's full (non-retention-limited) history -
 * the same source DefiLlama's own Blend and Sushi adapters use for exactly
 * this reason (Soroban RPC's getEvents only keeps ~4 months). */
async function fetchAllContractEvents(contractId: string, topic0: string): Promise<Array<{ bodyXdr: string }>> {
  const all: Array<{ bodyXdr: string }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const url =
      `${STELLAR_EXPERT}/contract/${contractId}/events?order=asc&limit=200` + (cursor ? `&cursor=${cursor}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`stellar.expert events fetch failed: HTTP ${res.status}`);
    const data = (await res.json()) as { _embedded?: { records?: Array<{ topics?: string[]; bodyXdr: string; paging_token: string }> } };
    const records = data._embedded?.records ?? [];
    if (records.length === 0) break;
    for (const r of records) {
      if (r.topics?.[0] === topic0) all.push({ bodyXdr: r.bodyXdr });
    }
    if (records.length < 200) break;
    cursor = records[records.length - 1].paging_token;
  }
  return all;
}

// Complete known Sushi Stellar pool set, enumerated from the factory's on-chain
// pool_created event history (Hubble) merged with every pool previously indexed.
// Baked in so discovery never depends on a single external source: stellar.expert's
// events API (the only non-RPC discovery source, used by fetchAllContractEvents
// below) began returning HTTP 402 Payment Required and silently zeroed out live
// Sushi capture for ~18h. 82 pools as of 2026-11-26; refresh from the factory's
// pool_created events when adding new ones.
const SUSHI_KNOWN_POOLS: readonly string[] = [
  'CA2VPJLBILTC5IJA4HYM7FOELC3TDJ2JH4PQ4KKCDS2NNTGDMBETLOOR',
  'CA3PZRINSFG2DUPLGG3XXOSUWEVWUQXEHRWCRNZJZTSS5KG6FGEHUMBZ',
  'CA5MIPAAG3UULVAHK7U3U6VBBM52YIHMCZOOSHNTPUSLYR7NKNHVD6WK',
  'CA5R5L7QE7WC2M4YAPSBITV7M2R6LX5366UURH3REHQMOJV6R5QWTH2K',
  'CA6LYAEDN7XHOKD5TNRFBM3IDFD22VRVVXTGPGK77FZFC7X2OYUQ7BAZ',
  'CA75VVHLWSM7W6ULNQI7ZJYDFOMQCCPKIDDDHBAL5KOKHWWKWQ5S7MHO',
  'CABMZD6BYKKLHRJNS5MURYOBX77NPAH767AI7EVFGWV3WZV55QFN5YNE',
  'CACU7KU33MFWMOP334RNQT7CZV3M7DNDAAXL5O3I4ATQRZCMXFJI4RMZ',
  'CADBRIKCLLP6BLZ6IMXGFDY52EQHXQ267S3FPARZ74SB5WPCEEB2T2KB',
  'CAFLJXGUAURAMBA3AIHC7ZJOAQKGZ7WEFFGMH5XRC35IMNU7PWIBXVTP',
  'CAKWXQDEVVUF2ABUEM3M2G7QJGJNDZNNVXJZYG4Z4QP6K54QTWV4DW2S',
  'CALM7JTAJC7AJ7ZGTQKXZNNILJUCD2AZNN7QA7FVM3YYIJBCJGUABEDH',
  'CAMUA6N6SLCMSIQRICXIQBRYYG3SCEPILS2HJTBXGMCOBCRWQUHAS2OJ',
  'CAOAVZOUDGYDI3QJTCDEQ3GJPWFN7QHM632EQZLWAIUWKILEFTKZUPE6',
  'CAOGXY6DW2KWUVOWCGGPLW7MIJNP7XCMXY736LNLOKYEQA3CBKXVIDEA',
  'CAPT5THGW7WOCX47TICCB5JZZK4Y24CHQIBSM57Y472WFFV6FGTRKJQD',
  'CAPUAZDFH4VBQTC7PYL7UM2KSXER2ZY3D462WW6DCE2HGUSO646S4F2X',
  'CAUBW4ARD42U2UEIA7GDUB5LNKTRTVYJHXKL3CV27YZRDFADDGKLZWFD',
  'CAWIGTP2YITU57IUU34YR6JFQZ3UGW6RNRUHRUFCXRIM36VHP4VGEIOP',
  'CAWN3BM2ADBMA4CQZLIHTBXA3BQHV4VAPK42LWT5ONAKZW6PH2BBCKLS',
  'CAWWOFOEGWPPNP6QKVHTJYB7UHRXC6W6EAFMUPGHMJL7K46E6UCOSNDM',
  'CAXJ2FDV6S3L46EFEFRXUBLQ5U5CZLZOG35RPCJRNQVLM5MH2HCK5I7J',
  'CB25COKXYEZIJPSPBOWHIQUJ4EHT4WKRX7E7V56L7IBWSE6F56EHPG6R',
  'CB5NNLVWQWN26VBOI576UVA4EGDGPKOHGNVTVYXREXAN2TO3XT6SCJL4',
  'CBBHUYY3YE7AOCLHFFVTOFHPMV3WBANNDIQBJ3NCNLXC7BLHRAM5YD7M',
  'CBBXZDNNIVCGGLLCH43KTH6WDZ5MFVYFQ5LTGD236A4A6OJMH2K4H6LA',
  'CBC45MVYLFTFAN6GMNPL4DZLCSXTMV5ECAZZOHX5QKJIBPEOSTWMRIHZ',
  'CBC5QQXD2G4RQ47CI4BJ7UPO4TMDJR46XQAIH5LD2ONSQWDG5R57WVXI',
  'CBDSEZBYZIMIX7KDTG4NYFIXJIGCIBSE56NK4GN2MBWZ4ODAFAEHO65Y',
  'CBFY4Q26RW5TYMWFFIVBP3CRMWHWNUD2GUFRQWNKRG4U53VELSSZ2OFQ',
  'CBGBQUEHEDIMA2P5JVHROPYVENY7Y3EA3DDYEMIW2HICRKFW7YDI635B',
  'CBOLCGXDSRU22SLUIJMFCJBOOURQLZHX5ZFIFJBYK2VAB3AEK5M2T5GM',
  'CBQIPFKHCXBLXJKSFSZJJLODGZDA6C33D5TUL3VAPXM25LH2YKNAROC2',
  'CBRKPTX4TWYEVGDTTVLSBVN6RKTFC2PKD6F5ZRSGBHQE7GC2UYMALTXY',
  'CBTOQ7X7TLDBRHJW4UYUDR7WR4NAYESZA7FYUZVLAN2JLQG5ZXWJJIG6',
  'CBTZO2GHYS23PW4QSHRNT66X62YZQJU7X3ZCZOKJTNEXKLR4WBYV54D7',
  'CBV7CK2DDLODRLTWFBWE7CN5WKN5B6O26ERTULNQIWJQ7ZBTHTGQ5YFI',
  'CBVHBZSZOS6KRDJ4D44FU2YLIENOVSSLM3UGKW6XQMVIFUAMWIWCVH2U',
  'CBVKO35SAF2ZT75FCLCGLYQG3S6B32YZTOJ2G5F7M746UGBRAWZ5BNZ6',
  'CBVZXBW5E5Q72J5ETZT4ZJLNS6GTLQC5BLUOERJNFQMMTKQCVY4N5YSX',
  'CC22BLZAFTS7M6Z25HOMKDLV65PBP5CIHFER2OTZB5IRNL3YBWDXKDFF',
  'CC22KKT4G3MSL5STSZDOC4KA5CTLCFTQX4ASASIGOE7Z3HI7HOY5F33H',
  'CC5DMYM44AFJOLCANORZRKD54D7FLLSTCF7G4C4VWBLZSIEVAKS2K5YI',
  'CCAQO6MKWCD463JZEIY5JUSU425H77LNYM3R6ZNQPO4KBU5C3SAEJDDB',
  'CCAS6XKE5MTV7HK6U4KH4BICZ6UHINGBXPKSHZ5IOZAD33FZAXTXLMI4',
  'CCF7MYFIILNDCDZ37QGYJQRYW455MPHA5PJIQ5D3KB3KEYLZA2WB26S2',
  'CCFWRAC3MB7JSPKAWSWT3MCRHVQECG3SU2JAMNAL3K2UHBQIYHBSR5LY',
  'CCI2P2I4MWU3J2RQ6YKJXQN46CB42LWAFCUYNWY2J2JVHZBIDR74TLBG',
  'CCKC4L6LI5ZNFKJCE7TVOEGGNJQPVHCCRJWMDYWEBL26SY62INCJLZMP',
  'CCL7NK6CVAZNYW5T5S3F3P2RXROM6Q7W2VQIKQW4NZ4GG636GUBKXNOH',
  'CCLXJ4F5STIZ7WWC5D2J57VCLLFIQMWUI5PSYJORPZTAUUQTS2XFU5ZK',
  'CCLYWZUZ3BPXMI3X4SOVMDU6IYXIXR5EZ2PLTIYGHNFBZELD7FF65SCT',
  'CCMPJ2PZDNG7DCQWU6YHF56U3QULE3JGMUVEZWBIWQOYHU6Z6QLEOEJQ',
  'CCOLSF35JVRGLONMJJMFYXUAEQ5IM4QOMYEWMXEFJEOQK3WVN4EJ3OUR',
  'CCPMUK2ZDDHWIQVYAWSEARMHPPI4MXMTUJYO2ON3YOAXUX3CPJICJHNQ',
  'CCQ4WKGF5PDJZ3PTDQBOOWD6HE67DEB3QHOGLF2VAWO2RBCGDT2DPDTI',
  'CCR2CH4GQVCZHG7CHFVMNANCK45CU5DVKXZIIITDZQAU3CEJZ7RQH2MQ',
  'CCRKQ2RHBWB5ZCHOSBSYEC2QNVSU3MGVUF56BWWKJMJIJ3ZF2A6W7KEC',
  'CCT74MCKWWPKHK5T7LXBPXK7AAPZIH35HJZY5CRZGVEJ4UUCMFQXBNVH',
  'CCUVVQJNVI3UBXHZ6LDW2BTULOKMFZWVYLY26QTP62AWUQCDPVNZWEPJ',
  'CCWJAQURY64U4VWI5GDLF42SH4RWFJZTYXO5BGA7SLNLVBGGV2L4EBIP',
  'CCXRRORTOXXP53HEKJ6RCG7CDRWZAJHIS4N7PDL32PUNMNN7VWPJVQWS',
  'CD2JLIZ5TSF746SVPNU224CY3ZIXTEII37CC4DNCTSDRLK4NAXBCQZLB',
  'CD6BHNV26Z7FOUU7VCFMYPRIB5JOG7724R42O5EJ4KGQXK3USO4NYOLS',
  'CD6L2VZHUEPJ745C4UZZZVTHWEP6IQWB2QHB2SQQHUMP7CUJLJE77AHU',
  'CD7QES7TILBZUCYQX33IUCZRDOCOJTSGIFJHTR44TS6DZVICI2VEP3R4',
  'CD7ZJUQEJODTJXWJMDJRV7UHCANOBX3FC6KXJV3DMIFX3JXUWMF3U3T5',
  'CDAUN7SBYWRAVKJA453ZGLEP4LFCR25ANTI6EIHKTWSSTWHYJXLD3EXT',
  'CDBUWTJRYRMOYS4ZBLOGSPACP6M5XNKC227DNIL5A36OBZEOBC3SBVKK',
  'CDDPO65MGM3HYYMFJJB7Y7NCRV2DAJ7YAFZYQQRMBLCR3WHFIPAZQCTS',
  'CDEB5XFEZXLL7FPUB5F4XDRHRS27HQRIKD3V2WSKNBE374BLQD47SCW2',
  'CDEXGN6YJXIPSMJZPU4NTJH6IVD47ZOG6GNTTMYK4X3U4JKLKD34F4XT',
  'CDGIQQBPGXATIEXWTFN5O6J7LM5IMQLMVIQ47Q4H44VIMMOBZ4N6KRVZ',
  'CDGW2GNQBS6VOWD2V6RCXDSNW3WVK7ZLB5FFU3ONWHVKXEM45YBJZPDZ',
  'CDMJRRH5MAJLB7T5SQAWQOOL7UJ3BABGTURSVKIE6AEDSXESDDJIBVCT',
  'CDNHCFJ6LGPV4OWZL2SAQPFQHAUFFVMWGBZFVPA5Z5HTL4A6RWEZYNM4',
  'CDNKJOHYEGVURFRDZQEREQPJJ4D3243OJBTXNC4ZWJWK65O6HZXXQSOG',
  'CDO6MTO4RYHFWWIG4DA3ZDHJ7GQMWA3BCZW4YTSBHEEDOJZV4BTJZB7M',
  'CDOE5KWIWFP7ITJHHN5LQ6GQZXSQPCBKT3FUJJ7QH3JJIXWS7EAJSMRC',
  'CDSOL7SBO2ZEASXAFZNDXGJUMIM7YOUBHQOXCCVQEKKYACIR43ZBH6MZ',
  'CDSZ2OJWMTM2YIQHUT6QSIPF7VW7O2LTOWUEWUYXBX63JJOAER4GE3T4',
  'CDVBYETOFG7UYJAD6CMOAQZXBHEK3PD5ZDZKWMWIY5OXIWATPX4VGMY2',
];

/**
 * Sushi Stellar's factory emits a `pool_created` event per pool; each event's
 * body is a map whose `pool_address` field is the real pool contract (mirrors
 * DefiLlama's own enumeration method:
 * https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/sushi-stellar/index.js).
 *
 * Seeds the complete known-pool baseline (SUSHI_KNOWN_POOLS) FIRST, then layers
 * the live stellar.expert fetch on top as best-effort to pick up pools created
 * after the baseline. Critically, a fetch failure (e.g. the HTTP 402 that took
 * Sushi offline for ~18h) is caught and logged rather than thrown, so discovery
 * degrades to the baseline instead of returning nothing - this is the ONLY
 * discovery source that depends on a non-RPC third-party API.
 */
export async function discoverSushiPools(
  factoryId = 'CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF'
): Promise<Record<string, ProtocolInfo>> {
  const result: Record<string, ProtocolInfo> = {};
  for (const pool of SUSHI_KNOWN_POOLS) {
    result[pool] = { protocolName: 'sushi_stellar', category: 'amm_pool' };
  }
  try {
    const events = await fetchAllContractEvents(factoryId, 'pool_created');
    for (const event of events) {
      const val = xdr.ScVal.fromXdr(Buffer.from(event.bodyXdr, 'base64'));
      const native = scValToNative(val) as { pool_address?: string };
      if (native?.pool_address) {
        result[native.pool_address] = { protocolName: 'sushi_stellar', category: 'amm_pool' };
      }
    }
  } catch (err) {
    console.warn(
      `Sushi live pool discovery failed, using ${SUSHI_KNOWN_POOLS.length}-pool baseline:`,
      (err as Error).message
    );
  }
  return result;
}

/**
 * DeFindex vaults ARE deployed through a real on-chain factory - an earlier
 * pass over this codebase assumed otherwise and relied entirely on
 * DeFindex's own discover API (api.defindex.io/vault/discover), the same
 * source DefiLlama's adapter uses. That assumption was wrong and badly
 * undercounted: confirmed 2026-09-30 that the factory
 * (CDKFHFJIET3A73A2YN4KV7NSV32S6YGQMUFH3DNJXLBWL4SKEGVRNFKI, from PaltaLabs'
 * own public deployment manifest -
 * https://github.com/paltalabs/defindex/blob/main/public/mainnet.contracts.json)
 * has deployed 117 real vaults via total_vaults()/get_vault_by_index(), while
 * the discover API returns only 14 and the old static registry fallback here
 * covered another 9 (the "Neko" family) - 94 vaults, 80% of the whole
 * protocol, were completely missing. Several aren't even DeFindex-branded:
 * other teams ("SAFU Protection", "Blockroll Nest", "Prism USTRY" confirmed
 * in the factory's own create_defindex_vault call history) white-label
 * DeFindex as vault infrastructure, and none of those show up in DeFindex's
 * API either. Every instance's WASM hash matches the factory manifest's own
 * `defindex_vault` hash (ae3409a4...f8e1468b), confirming they're all
 * genuine factory-deployed vaults, not lookalikes.
 *
 * Paginated with the same per-call delay as discoverSoroswapPairs/
 * discoverAquariusPools for the same mainnet.sorobanrpc.com rate-limit
 * reason - this makes up to ~117 sequential calls (grows over time as more
 * vaults are created).
 */
export async function discoverDeFindexVaults(
  factoryId = 'CDKFHFJIET3A73A2YN4KV7NSV32S6YGQMUFH3DNJXLBWL4SKEGVRNFKI'
): Promise<Record<string, ProtocolInfo>> {
  const server = new rpc.Server(RPC_URL);
  const total = Number(await simulateReadOnlyCall(server, factoryId, 'total_vaults'));

  const result: Record<string, ProtocolInfo> = {};
  for (let i = 0; i < total; i++) {
    if (i > 0) await sleep(75);
    const addr = (await simulateReadOnlyCall(server, factoryId, 'get_vault_by_index', [
      nativeToScVal(i, { type: 'u32' })
    ])) as string;
    result[addr] = { protocolName: 'defindex', category: 'yield_savings' };
  }
  return result;
}

/**
 * Aquarius pools are NOT internal state of one shared AMM contract - an
 * earlier pass over this codebase assumed that (see the old comment in
 * registry.ts) and it was wrong, discovered 2026-09-29 by reading
 * DefiLlama's actual Aquarius adapter source rather than re-deriving it:
 * https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/aqua-network/index.js
 *
 * The registered "aquarius" address (CBQDHN...C6QUK) is Aquarius's
 * LiquidityPoolRouter, not a pool itself. Pools are individually deployed
 * contracts, exactly like Soroswap's pairs - the router just enumerates
 * them via get_tokens_sets_count + get_pools_for_tokens_range. Confirmed by
 * direct example: CA6PUJ...CJBE ("[Aquarius Pool]" per stellar.expert,
 * ~$3.9m balance, swapping every few seconds since 2024-07-29) had exactly
 * ONE event in our entire indexed history before this fix - picked up only
 * incidentally as an asset reference inside an aggregator's swap path, never
 * tracked as its own pool. This almost certainly means years of missed
 * direct-pool activity on our #2-by-TVL protocol - see
 * project_missed_contracts_backfill_list memory for the reindex list this
 * feeds.
 *
 * Paginated in batches (same rate-limit rationale as discoverSoroswapPairs)
 * since the real token-set count is unknown until the first call.
 */
export async function discoverAquariusPools(
  routerId = 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK',
  pageSize = 25
): Promise<Record<string, ProtocolInfo>> {
  const server = new rpc.Server(RPC_URL);
  const totalSets = Number(await simulateReadOnlyCall(server, routerId, 'get_tokens_sets_count'));

  const result: Record<string, ProtocolInfo> = {};
  for (let start = 0; start < totalSets; start += pageSize) {
    if (start > 0) await sleep(75);
    const end = Math.min(start + pageSize, totalSets);
    const batch = (await simulateReadOnlyCall(server, routerId, 'get_pools_for_tokens_range', [
      nativeToScVal(start, { type: 'u128' }),
      nativeToScVal(end, { type: 'u128' })
    ])) as Array<[unknown, Record<string, string>]>;
    for (const [, poolsMap] of batch) {
      for (const poolAddr of Object.values(poolsMap)) {
        result[poolAddr] = { protocolName: 'aquarius', category: 'amm_liquidity' };
      }
    }
  }
  return result;
}

/**
 * Runs every discovery source, merges the results, and never throws: one
 * source failing (a factory changing its interface, an API going down)
 * shouldn't stop the indexer from starting with whatever it already has in
 * the static registry. Call this once at startup - see indexer.ts.
 */
export async function discoverAllDynamicPools(): Promise<Record<string, ProtocolInfo>> {
  const sources: Array<[string, () => Promise<Record<string, ProtocolInfo>>]> = [
    ['Soroswap pairs', discoverSoroswapPairs],
    ['Sushi Stellar pools', discoverSushiPools],
    ['DeFindex vaults', discoverDeFindexVaults],
    ['Aquarius pools', discoverAquariusPools]
  ];

  const merged: Record<string, ProtocolInfo> = {};
  for (const [label, fn] of sources) {
    try {
      const found = await fn();
      Object.assign(merged, found);
      console.log(`🔎 Discovered ${Object.keys(found).length} ${label}`);
    } catch (err) {
      console.error(`Pool discovery failed for ${label}, continuing without it:`, err);
    }
  }
  return merged;
}

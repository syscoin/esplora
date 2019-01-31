import 'babel-polyfill'
import { Observable as O } from './rxjs'

import { dbg, combine, extractErrors, dropErrors, last, updateQuery, notNully, tryUnconfidentialAddress} from './util'
import l10n, { defaultLang } from './l10n'
import * as views from './views'

if (process.browser) {
  require('bootstrap/js/dist/collapse')
}

const apiBase = (process.env.API_URL || '/api').replace(/\/+$/, '')
    , setBase = ({ ...r, path }) => ({ ...r, url: apiBase + path })

// Temporary bug workaround. Listening with on('form.search', 'submit') was unable
// to catch some form submissions.
const searchSubmit$ = !process.browser ? O.empty() : O.fromEvent(document.body, 'submit')
  .filter(e => e.target.classList.contains('search'))

export default function main({ DOM, HTTP, route, storage, search: searchResult$ }) {
  const

    reply = (cat, raw) => dropErrors(HTTP.select(cat)).map(r => raw ? r : (r.body || r.text))
  , on    = (sel, ev, opt={}) => DOM.select(sel).events(ev, opt)
  , click = sel => on(sel, 'click').map(e => e.ownerTarget.dataset)

  /// User actions
  , page$     = route()
  , goHome$   = route('/').map(loc => ({ start_height: loc.query.start }))
  , goBlock$  = route('/block/:hash').map(loc => loc.params.hash)
  , goHeight$ = route('/block-height/:height').map(loc => loc.params.height)
  , goAddr$   = route('/address/:addr').map(loc => loc.params.addr).map(tryUnconfidentialAddress)
  , goTx$     = route('/tx/:txid').map(loc => loc.params.txid)
  , goSearch$ = route('/:q([a-zA-Z0-9]+)').map(loc => loc.params.q === 'search' ? loc.query.q : loc.params.q)

  // auto-expand when opening with "#expand"
  , expandTx$ = route('/tx/:txid').filter(loc => loc.query.expand).map(loc => loc.params.txid)
  , expandBl$ = route('/block/:hash').filter(loc => loc.query.expand).map(loc => loc.params.hash)

  , togTx$    = click('[data-toggle-tx]').map(d => d.toggleTx).merge(page$.mapTo(null), expandTx$)
  , togBlock$ = click('[data-toggle-block]').map(d => d.toggleBlock).merge(page$.mapTo(null), expandBl$)
  , togTheme$ = click('.toggle-theme')

  , copy$     = click('[data-clipboard-copy]').map(d => d.clipboardCopy)
  , query$    = O.merge(searchSubmit$.map(e => e.target.querySelector('[name=q]').value), goSearch$)

  , moreBlocks$ = click('[data-loadmore-block-height]').map(d => ({ start_height: d.loadmoreBlockHeight }))
  , moreBTxs$   = click('[data-loadmore-txs-block]').map(d => ({ block: d.loadmoreTxsBlock, start_index: d.loadmoreTxsIndex }))
  , moreATxs$   = click('[data-loadmore-txs-addr]').map(d => ({ addr: d.loadmoreTxsAddr, last_txid: d.loadmoreTxsLastTxid }))

  , lang$ = storage.local.getItem('lang').first().map(lang => lang || defaultLang)
      .concat(on('select[name=lang]', 'input').map(e => e.target.value))
      .distinctUntilChanged()

  /// Model

  , error$ = extractErrors(HTTP.select().filter(r$ => !r$.request.bg && !r$.request.ignore_err))
      .merge(process.browser ? O.empty() : searchResult$.filter(found => !found).mapTo('No search results found'))
      // in browser env, this is displayed as a tooltip rather than as an error

  , tipHeight$ = reply('tip-height', true).map(res => +res.text)

  // the translation function for the currently selected language
  , t$ = lang$.map(lang => l10n[lang] || l10n[defaultLang])

  // Active theme
  , theme$ = storage.local.getItem('theme').first().map(theme => theme || 'dark')
      .concat(togTheme$).scan(curr => curr == 'dark' ? 'light' : 'dark')

  // Keep track of the number of active in-flight HTTP requests
  , loading$ = HTTP.select().filter(r$ => !r$.request.bg)
      .flatMap(r$ => r$.mapTo(-1).catch(_ => O.of(-1)).startWith(+1))
      .merge(query$.mapTo(+1)).merge(searchResult$.mapTo(-1))
      .startWith(0).scan((N, a) => N+a)

  // Recent blocks
  , blocks$ = O.merge(
      reply('blocks').map(blocks => S => [ ...(S || []), ...blocks ])
    , goHome$.map(_ => S => null)
    ).startWith(null).scan((S, mod) => mod(S))

  , nextMoreBlocks$ = blocks$.map(blocks => blocks && blocks.length && last(blocks).height).map(height => height > 0 ? height-1 : null)

  // Single block and associated txs
  , block$ = reply('block').merge(goBlock$.mapTo(null))
  , blockStatus$ = reply('block-stat').merge(goBlock$.mapTo(null))
  , blockTxs$ = O.merge(
      reply('block-txs').map(txs => S => [ ...(S || []), ...txs ])
    , goBlock$.map(_ => S => null)
    ).startWith(null).scan((S, mod) => mod(S))

  , nextMoreBTxs$ = O.combineLatest(block$, blockTxs$, (block, txs) => block && txs && block.tx_count > txs.length ? txs.length : null)

  // Hash by height search
  , byHeight$ = reply('height', true).map(r => r.text)

  // Address and associated txs
  , addr$ = reply('address').merge(goAddr$.mapTo(null))
  , addrTxs$ = O.merge(
      reply('addr-txs').map(txs => S => txs)
    , reply('addr-txs-chain').map(txs => S => [ ...S, ...txs ])
    , goAddr$.map(_ => S => null)
    ).startWith(null).scan((S, mod) => mod(S))

  , nextMoreATxs$ = O.combineLatest(addr$, addrTxs$, (addr, txs) =>
      (addr && txs && txs.length && addr.chain_stats.tx_count > 0 && addr.chain_stats.tx_count+addr.mempool_stats.tx_count > txs.length)
      ? last(txs).txid
      : null
  )

  // Single TX
  , tx$ = reply('tx').merge(goTx$.mapTo(null))

  // Currently collapsed tx/block ("details")
  , openTx$ = togTx$.startWith(null).scan((prev, txid) => prev == txid ? null : txid)
  , openBlock$ = togBlock$.startWith(null).scan((prev, blockhash) => prev == blockhash ? null : blockhash)

  // Spending txs map (reset on every page nav)
  , spends$ = O.merge(
    reply('tx-spends', true).map(r => S => ({ ...S, [r.request.txid]: r.body }))
  , page$.mapTo(S => ({}))
  ).startWith({}).scan((S, mod) => mod(S))

  // Currently visible view
  , view$ = O.merge(page$.mapTo(null)
                  , blocks$.filter(notNully).mapTo('home')
                  , block$.filter(notNully).mapTo('block')
                  , tx$.filter(notNully).mapTo('tx')
                  , addr$.filter(notNully).mapTo('addr')
                  , error$.mapTo('error'))
      .combineLatest(loading$, (view, loading) => view || (loading ? 'loading' : 'notFound'))

  // Page title
  , title$ = O.merge(page$.mapTo(null)
                   , block$.filter(notNully).withLatestFrom(t$, (block, t) => t`Block #${block.height}: ${block.id}`)
                   , tx$.filter(notNully).withLatestFrom(t$, (tx, t) => t`Transaction: ${tx.txid}`)
                   , addr$.filter(notNully).withLatestFrom(t$, (addr, t) => t`Address: ${addr.address}`))

  // App state
  , state$ = combine({ t$, error$, tipHeight$, spends$
                     , blocks$, nextMoreBlocks$
                     , block$, blockStatus$, blockTxs$, nextMoreBTxs$, openBlock$
                     , tx$, openTx$
                     , addr$, addrTxs$, nextMoreATxs$
                     , loading$, page$, view$, title$, theme$
                     })

  // Update query options with ?expand
  , updateQuery$ = O.merge(
      openTx$.withLatestFrom(view$).filter(([ _, view]) => view == 'tx').pluck(0)
    , openBlock$.withLatestFrom(view$).filter(([ _, view]) => view == 'block').pluck(0)
    )
    .map(Boolean).distinctUntilChanged()
    .withLatestFrom(route.all$)
    .filter(([ expand, page ]) => page.query.expand != expand)
    .map(([ expand, page ]) => [ page.pathname, updateQuery(page.query, { expand }) ])

  /// Sinks

  // HTTP request sink
  , req$ = O.merge(
    // fetch single block, its status and its txs
      goBlock$.flatMap(hash => [{ category: 'block',      method: 'GET', path: `/block/${hash}` }
                              , { category: 'block-stat', method: 'GET', path: `/block/${hash}/status` }
                              , { category: 'block-txs',  method: 'GET', path: `/block/${hash}/txs` } ])

    // fetch single tx (including confirmation status)
    , goTx$.map(txid        => ({ category: 'tx',         method: 'GET', path: `/tx/${txid}` }))

    // fetch address and its txs
    , goAddr$.flatMap(addr  => [{ category: 'address',    method: 'GET', path: `/address/${addr}` }
                              , { category: 'addr-txs',   method: 'GET', path: `/address/${addr}/txs`, ignore_err: true }])

    // fetch list of blocks for homepage
    , O.merge(goHome$, moreBlocks$)
        .map(d              => ({ category: 'blocks',     method: 'GET', path: `/blocks/${d.start_height || ''}` }))

    // fetch more txs for block page
    , moreBTxs$.map(d       => ({ category: 'block-txs',  method: 'GET', path: `/block/${d.block}/txs/${d.start_index}` }))

    // fetch more txs for address page
    , moreATxs$.map(d       => ({ category: 'addr-txs-chain', method: 'GET', path: `/address/${d.addr}/txs/chain/${d.last_txid}` }))

    // fetch block by height
    , goHeight$.map(n       => ({ category: 'height',     method: 'GET', path: `/block-height/${n}` }))

    // fetch spending txs when viewing advanced details
    , openTx$.filter(notNully)
        .map(txid           => ({ category: 'tx-spends',  method: 'GET', path: `/tx/${txid}/outspends`, txid }))

    // in browser env, get the tip every 30s (but only when the page is active) or when we render a block/tx/addr, but not more than once every 5s
    // in server env, just get it once
    , (process.browser ? O.merge(O.timer(0, 30000).filter(() => document.hasFocus()), goBlock$, goTx$, goAddr$).throttleTime(5000)
                      : O.of(1)
        ).mapTo(                { category: 'tip-height', method: 'GET', path: '/blocks/tip/height', bg: true } )

    ).map(setBase)

  // DOM sink
  , vdom$ = state$.map(S => S.view ? views[S.view](S) : null)

  // localStorage sink
  , store$ = O.merge(
      lang$.skip(1).map(lang => ({ key: 'lang', value: lang }))
    , theme$.skip(1).map(theme => ({ key: 'theme', value: theme }))
  )

  // Route navigation sink
  , navto$ = O.merge(
      searchResult$.filter(Boolean).map(path => ({ type: 'push', pathname: path }))
    , byHeight$.map(hash => ({ type: 'replace', pathname:`/block/${hash}` }))
    , updateQuery$.map(([ pathname, qs ]) => ({ type: 'replace', pathname: pathname+qs, state: { noRouting: true } }))
  )

  dbg({ goHome$, goBlock$, goTx$, togTx$, page$, lang$
      , openTx$, openBlock$, updateQuery$
      , state$, view$, block$, blockTxs$, blocks$, tx$, spends$
      , tipHeight$, error$, loading$
      , query$, searchResult$, copy$, store$, navto$
      , req$, reply$: dropErrors(HTTP.select()).map(r => [ r.request.category, r.req.method, r.req.url, r.body||r.text, r ]) })

  // @XXX side-effects outside of drivers
  if (process.browser) {

    // Display "No results found"
    searchResult$.filter(found => !found).map(_ => document.querySelector('[name=q]'))
      .filter(el => !!el)
      .withLatestFrom(t$)
      .subscribe(([el, t]) => (el.setCustomValidity(t`No results found`), el.reportValidity()))
    on('[name=q]', 'input').subscribe(e => e.target.setCustomValidity(''))

    searchSubmit$.subscribe(e => e.preventDefault())

    // Click-to-copy
    if (navigator.clipboard) copy$.subscribe(text => navigator.clipboard.writeText(text))

    // Switch stylesheet based on current language
    const stylesheet = document.querySelector('link[href="style.css"]')
    t$.map(t => t`style.css`).distinctUntilChanged().subscribe(styleSrc =>
      stylesheet.getAttribute('href') != styleSrc && (stylesheet.href = styleSrc))

    // Apply dark/light theme, language and text direction to root element
    theme$.subscribe(theme => {
      document.body.classList.remove('theme-dark', 'theme-light')
      document.body.classList.add(`theme-${theme}`)
    })
    t$.subscribe(t => {
      document.body.setAttribute('lang', t.lang_id)
      document.body.setAttribute('dir', t`ltr`)
    })

    // Reset scrolling when navigating to a new page (but not when hitting 'back')
    page$.startWith([ ]).scan((prevKeys, loc) => [ ...prevKeys.slice(0, 15), loc.key ])
      .filter(keys => keys.length && !keys.slice(0, -1).includes(last(keys)))
      .subscribe(_ => window.scrollTo(0, 0))

    // Scroll elements selected via URL hash into view
    DOM.select('.ins-and-outs .selected').elements()
      .filter(els => !!els.length)
      .map(els => els[0])
      .distinctUntilChanged().delay(300)
      .subscribe(el => el.scrollIntoView({ behavior: 'smooth' }))

    // Display "Copied!" tooltip
    on('[data-clipboard-copy]', 'click').subscribe(({ ownerTarget: btn }) => {
      btn.classList.add('show-tooltip')
      setTimeout(_ => btn.classList.remove('show-tooltip'), 700)
    })
  }

  return { DOM: vdom$, HTTP: req$, route: navto$, storage: store$, search: query$, title: title$, state: state$ }
}

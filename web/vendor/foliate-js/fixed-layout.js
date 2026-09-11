const parseViewport = str => str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const getGraphicDimensions = doc => {
    const image = doc?.querySelector('img')
    if (image?.naturalWidth > 0 && image?.naturalHeight > 0)
        return { width: image.naturalWidth, height: image.naturalHeight }
    const svg = doc?.querySelector('svg')
    const values = svg?.getAttribute('viewBox')?.trim().split(/[\s,]+/) ?? []
    const width = values[2] ?? svg?.getAttribute('width')
    const height = values[3] ?? svg?.getAttribute('height')
    const parsedWidth = parseFloat(width)
    const parsedHeight = parseFloat(height)
    return Number.isFinite(parsedWidth) && parsedWidth > 0
        && Number.isFinite(parsedHeight) && parsedHeight > 0
        ? { width: parsedWidth, height: parsedHeight }
        : null
}

const getViewport = (doc, viewport) => {
    // use `viewBox` for SVG
    if (doc.documentElement.localName === 'svg') {
        const viewBox = doc.documentElement.getAttribute('viewBox')
            ?.trim().split(/[\s,]+/) ?? []
        const width = viewBox[2] ?? doc.documentElement.getAttribute('width')
        const height = viewBox[3] ?? doc.documentElement.getAttribute('height')
        if (width && height) return { width, height }
    }

    // get `viewport` `meta` element
    const meta = parseViewport(doc.querySelector('meta[name="viewport"]')
        ?.getAttribute('content'))
    if (meta) return Object.fromEntries(meta)

    // Image wrapper pages often omit a viewport entirely. Their intrinsic
    // dimensions are more faithful than a book-level fallback resolution.
    const graphic = getGraphicDimensions(doc)
    if (graphic) return graphic

    // fallback to book's viewport
    if (typeof viewport === 'string') {
        const parsed = parseViewport(viewport)
        if (parsed) return Object.fromEntries(parsed)
    }
    if (viewport?.width && viewport.height) return viewport

    // if no viewport (possibly with image directly in spine), get image size
    // just show *something*, i guess...
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

export class FixedLayout extends HTMLElement {
    static observedAttributes = ['zoom']
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => {
        this.#render()
        if (this.#index >= 0) this.#reportLocation('resize')
    })
    #spreads
    #index = -1
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    #zoom
    #autoSpread = false
    constructor() {
        super()

        const sheet = new CSSStyleSheet()
        this.#root.adoptedStyleSheets = [sheet]
        sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: auto;
            -ms-overflow-style: none;
            scrollbar-width: none;
        }
        :host::-webkit-scrollbar {
            display: none;
            width: 0;
            height: 0;
        }`)

        this.#observer.observe(this)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'zoom':
                this.#zoom = value !== 'fit-width' && value !== 'fit-page'
                    ? parseFloat(value) : value
                this.#render()
                break
        }
    }
    async #createFrame({ index, src: srcOption } = {}) {
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom
        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        // WebKit does not dispatch clicks from a sandboxed document without
        // allow-scripts. The EPUB loader injects a strict script-free CSP, so
        // this only restores host-side link/event delivery.
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        this.#root.append(element)
        if (!src) return { blank: true, element, iframe, index }
        return new Promise(resolve => {
            iframe.addEventListener('load', async () => {
                const doc = iframe.contentDocument
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                await Promise.all(Array.from(doc?.images ?? [], image =>
                    image.decode ? image.decode().catch(() => undefined) : Promise.resolve()))
                const { width, height } = getViewport(doc, this.defaultViewport)
                const graphic = getGraphicDimensions(doc)
                const parsedWidth = parseFloat(width)
                const parsedHeight = parseFloat(height)
                resolve({
                    element, iframe, index,
                    width: Number.isFinite(parsedWidth) && parsedWidth > 0
                        ? parsedWidth : graphic?.width || 1000,
                    height: Number.isFinite(parsedHeight) && parsedHeight > 0
                        ? parsedHeight : graphic?.height || 2000,
                    contentWidth: graphic?.width,
                    contentHeight: graphic?.height,
                    onZoom,
                })
            }, { once: true })
            iframe.src = src
        })
    }
    #render(side = this.#side) {
        if (!side) return
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right ?? {}
        const target = side === 'left' ? left : right
        const { width, height } = this.getBoundingClientRect()
        const pageWidth = (left.width ?? right.width ?? 0) + (right.width ?? left.width ?? 0)
        const pageHeight = Math.max(left.height ?? 0, right.height ?? 0)
        const heightScale = pageHeight > 0 ? height / pageHeight : 0
        // A native landscape/cross-page artwork is authored as one page. Keep
        // it by itself even when the surrounding container has room for two
        // ordinary portrait pages.
        const widePage = this.#autoSpread && !this.#center
            && [left, right].some(frame => {
                const frameWidth = frame.contentWidth ?? frame.width
                const frameHeight = frame.contentHeight ?? frame.height
                return frameWidth > 0 && frameHeight > 0
                    && frameWidth / frameHeight >= 1.5
            })
        const canSpread = this.#autoSpread && !!this.#left && !!this.#right
            && !this.#left.blank && !this.#right.blank
            && !widePage
            && width >= pageWidth * heightScale + 8
        const portrait = this.#autoSpread
            ? !canSpread
            : this.spread !== 'both' && this.spread !== 'portrait' && height > width
        this.#portrait = portrait
        const blankWidth = left.width ?? right.width ?? 0
        const blankHeight = left.height ?? right.height ?? 0

        const scale = typeof this.#zoom === 'number' && !isNaN(this.#zoom)
            ? this.#zoom
            : (this.#zoom === 'fit-width'
                ? (portrait || this.#center
                    ? width / (target.width ?? blankWidth)
                    : width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)))
                : (portrait || this.#center
                    ? Math.min(
                        width / (target.width ?? blankWidth),
                        height / (target.height ?? blankHeight))
                    : Math.min(
                        width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                        height / Math.max(
                            left.height ?? blankHeight,
                            right.height ?? blankHeight)))
            ) || 1

        const transform = frame => {
            let { element, iframe, width, height, blank, onZoom } = frame
            if (!iframe) return
            if (onZoom) onZoom({ doc: frame.iframe.contentDocument, scale })
            const iframeScale = onZoom ? scale : 1
            Object.assign(iframe.style, {
                width: `${width * iframeScale}px`,
                height: `${height * iframeScale}px`,
                transform: onZoom ? 'none' : `scale(${scale})`,
                transformOrigin: 'top left',
                display: blank ? 'none' : 'block',
            })
            Object.assign(element.style, {
                width: `${(width ?? blankWidth) * scale}px`,
                height: `${(height ?? blankHeight) * scale}px`,
                overflow: 'hidden',
                display: 'block',
                flexShrink: '0',
                marginBlock: 'auto',
                marginInlineEnd: !portrait && frame === this.#left ? '8px' : '0',
            })
            if (portrait && frame !== target) {
                element.style.display = 'none'
            }
        }
        if (this.#center) {
            transform(this.#center)
        } else {
            transform(left)
            transform(right)
        }
    }
    async #showSpread({ left, right, center, side }) {
        this.#root.replaceChildren()
        this.#left = null
        this.#right = null
        this.#center = null
        if (center) {
            this.#center = await this.#createFrame(center)
            this.#side = 'center'
            this.#render()
        } else {
            this.#left = await this.#createFrame(left)
            this.#right = await this.#createFrame(right)
            this.#side = this.#left.blank ? 'right'
                : this.#right.blank ? 'left' : side ?? (this.rtl ? 'right' : 'left')
            this.#render()
        }
    }
    #goLeft() {
        if (this.#center || this.#left?.blank) return
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            this.#side = 'left'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    #goRight() {
        if (this.#center || this.#right?.blank) return
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            this.#side = 'right'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    open(book) {
        this.book = book
        const { rendition } = book
        this.#autoSpread = rendition?.autoSpread === true
        this.spread = this.#autoSpread ? 'both' : rendition?.spread
        this.defaultViewport = rendition?.viewport

        const rtl = book.dir === 'rtl'
        const ltr = !rtl
        this.rtl = rtl

        if (rendition?.spread === 'none' && !this.#autoSpread)
            this.#spreads = book.sections.map(section => ({ center: section }))
        else if (this.#autoSpread) this.#spreads = book.sections.reduce((arr, section, i) => {
            const last = arr[arr.length - 1]
            if (section.pageSpread === 'center' || (i === 0 && /cover/i.test(section.id ?? ''))) {
                if (last.center || last.left || last.right) arr.push({ center: section })
                else last.center = section
            } else if (section.pageSpread === 'left') {
                if (last.center || last.left || last.right) arr.push({ left: section })
                else last.left = section
            } else if (section.pageSpread === 'right') {
                if (last.center || last.right) arr.push({ right: section })
                else last.right = section
            } else if (book.dir === 'rtl') {
                if (last.center || last.left || last.right) {
                    if (last.right && !last.left) last.left = section
                    else arr.push({ right: section })
                } else last.right = section
            } else if (last.center || last.left || last.right) {
                if (last.left && !last.right) last.right = section
                else arr.push({ left: section })
            } else last.left = section
            return arr
        }, [{}])
        else this.#spreads = book.sections.reduce((arr, section, i) => {
            const last = arr[arr.length - 1]
            const { pageSpread } = section
            const newSpread = () => {
                const spread = {}
                arr.push(spread)
                return spread
            }
            if (pageSpread === 'center') {
                const spread = last.left || last.right ? newSpread() : last
                spread.center = section
            }
            else if (pageSpread === 'left') {
                const spread = last.center || last.left || ltr && i ? newSpread() : last
                spread.left = section
            }
            else if (pageSpread === 'right') {
                const spread = last.center || last.right || rtl && i ? newSpread() : last
                spread.right = section
            }
            else if (ltr) {
                if (last.center || last.right) newSpread().left = section
                else if (last.left || !i) last.right = section
                else last.left = section
            }
            else {
                if (last.center || last.left) newSpread().right = section
                else if (last.right || !i) last.left = section
                else last.right = section
            }
            return arr
        }, [{}])
    }
    get index() {
        const spread = this.#spreads[this.#index]
        const section = spread?.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
    }
    get atStart() {
        if (this.#index > 0) return false
        const spread = this.#spreads[this.#index]
        if (this.#portrait && spread && !spread.center && spread.left && spread.right)
            return this.rtl ? this.#side === 'right' : this.#side === 'left'
        return true
    }
    get atEnd() {
        if (this.#index < this.#spreads.length - 1) return false
        const spread = this.#spreads[this.#index]
        if (this.#portrait && spread && !spread.center && spread.left && spread.right)
            return this.rtl ? this.#side === 'left' : this.#side === 'right'
        return true
    }
    get visiblePages() {
        const spread = this.#spreads[this.#index]
        if (!spread) return []
        const sections = spread.center
            ? [spread.center]
            : this.#portrait
                ? [this.#side === 'right' ? spread.right : spread.left]
                : [spread.left, spread.right]
        return sections
            .filter(Boolean)
            .map(section => this.book.sections.indexOf(section))
            .filter(index => index >= 0)
    }
    #reportLocation(reason) {
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: this.index, fraction: 0, size: 1 } }))
    }
    getSpreadOf(section) {
        const spreads = this.#spreads
        for (let index = 0; index < spreads.length; index++) {
            const { left, right, center } = spreads[index]
            if (left === section) return { index, side: 'left' }
            if (right === section) return { index, side: 'right' }
            if (center === section) return { index, side: 'center' }
        }
    }
    async goToSpread(index, side, reason) {
        if (index < 0 || index > this.#spreads.length - 1) return
        if (index === this.#index) {
            const changed = !!side && side !== this.#side
            if (side) this.#side = side
            this.#render(side)
            if (changed) this.#reportLocation(reason ?? 'page')
            return
        }
        this.#index = index
        const spread = this.#spreads[index]
        if (spread.center) {
            const index = this.book.sections.indexOf(spread.center)
            const src = await spread.center?.load?.()
            await this.#showSpread({ center: { index, src } })
        } else {
            const indexL = this.book.sections.indexOf(spread.left)
            const indexR = this.book.sections.indexOf(spread.right)
            const srcL = await spread.left?.load?.()
            const srcR = await spread.right?.load?.()
            const left = { index: indexL, src: srcL }
            const right = { index: indexR, src: srcR }
            await this.#showSpread({ left, right, side })
        }
        this.#reportLocation(reason)
    }
    async select(target) {
        await this.goTo(target)
        // TODO
    }
    async goTo(target) {
        const { book } = this
        const resolved = await target
        const section = book.sections[resolved.index]
        if (!section) return
        const { index, side } = this.getSpreadOf(section)
        await this.goToSpread(index, side)
    }
    async next() {
        const s = this.rtl ? this.#goLeft() : this.#goRight()
        if (!s) return this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left', 'page')
    }
    async prev() {
        const s = this.rtl ? this.#goRight() : this.#goLeft()
        if (!s) return this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right', 'page')
    }
    getContents() {
        return [this.#left, this.#center, this.#right]
            .filter(Boolean)
            .map(frame => ({ doc: frame.iframe.contentDocument, index: frame.index }))
    }
    destroy() {
        this.#observer.unobserve(this)
    }
}

customElements.define('foliate-fxl', FixedLayout)

import intl from "react-intl-universal"
import * as db from "../../db"
import lf from "lovefield"
import { ServiceHooks } from "../service"
import { ServiceConfigs, SyncService } from "../../../schema-types"
import { createSourceGroup } from "../group"
import { RSSSource } from "../source"
import { htmlDecode } from "../../utils"
import { RSSItem } from "../item"
import { SourceRule } from "../rule"

// miniflux service configs
export interface MinifluxConfigs extends ServiceConfigs {
    type: SyncService.Miniflux
    endpoint: string
    apiKeyAuth: boolean
    authKey: string
    fetchLimit: number
    lastId?: number
}

// partial api schema
interface Feed {
    id: number
    feed_url: string
    title: string
    category: { title: string }
}

interface Category {
    title: string
}

interface Entry {
    id: number
    status: "unread" | "read" | "removed"
    title: string
    url: string
    published_at: string
    created_at: string
    content: string
    author: string
    starred: boolean
    feed: Feed
}

interface Entries {
    total: number
    entries: Entry[]
}

const APIError = () => new Error(intl.get("service.failure"))

// base endpoint, authorization with dedicated token or http basic user/pass pair
async function fetchAPI(
    configs: MinifluxConfigs,
    endpoint: string = "",
    method: string = "GET",
    body: string = null,
): Promise<Response> {
    try {
        const headers = new Headers()
        headers.append("content-type", "application/x-www-form-urlencoded")

        configs.apiKeyAuth
            ? headers.append("X-Auth-Token", configs.authKey)
            : headers.append("Authorization", `Basic ${configs.authKey}`)

        let baseUrl = configs.endpoint
        if (!baseUrl.endsWith("/")) {
            baseUrl += "/"
        }
        if (!baseUrl.endsWith("/v1/")) {
            baseUrl += "v1/"
        }
        return await fetch(baseUrl + endpoint, {
            method: method,
            body: body,
            headers: headers,
        })
    } catch (error) {
        console.log(error)
        throw APIError()
    }
}

async function fetchEntries(
    configs: MinifluxConfigs,
    queryParams: URLSearchParams,
    fetchNew: boolean = false,
    fetchLimit: number = 125,
): Promise<Entry[]> {
    const items: Entry[] = []
    let entriesResponse: Entries | null = null

    // parameters
    configs.lastId = configs.lastId ?? 0
    let continueId: number | undefined
    queryParams.set("limit", String(fetchLimit))

    do {
        try {
            if (continueId) {
                queryParams.set("before_entry_id", String(continueId))
            } else if (fetchNew) {
                queryParams.set("after_entry_id", String(configs.lastId))
            }

            const queryString = queryParams.toString()
            entriesResponse = await fetchAPI(
                configs,
                `entries?${queryString}`,
            ).then(response => response.json())
            if (entriesResponse.entries.length === 0) {
                break
            }

            items.push(...entriesResponse.entries)
            if (fetchNew) {
                continueId = items[items.length - 1].id
            } else {
                continueId =
                    entriesResponse.entries[entriesResponse.entries.length - 1]
                        .id
            }
        } catch {
            break
        }
    } while (
        entriesResponse &&
        entriesResponse.total >= fetchLimit &&
        items.length < configs.fetchLimit
    )

    return items
}

export const minifluxServiceHooks: ServiceHooks = {
    // poll service info endpoint to verify auth
    authenticate: async (configs: MinifluxConfigs) => {
        const response = await fetchAPI(configs, "me")
        return !(await response.json().then(json => json.error_message))
    },

    // collect sources from service, along with associated groups/categories
    updateSources: () => async (dispatch, getState) => {
        const configs = getState().service as MinifluxConfigs

        // fetch and create groups in redux
        if (configs.importGroups) {
            const groups: Category[] = await fetchAPI(
                configs,
                "categories",
            ).then(response => response.json())
            groups.forEach(group => dispatch(createSourceGroup(group.title)))
        }

        // fetch all feeds
        const feedResponse = await fetchAPI(configs, "feeds")
        const feeds = await feedResponse.json()

        if (feeds === undefined) {
            throw APIError()
        }

        // go through feeds, create typed source while also mapping by group
        const sources: RSSSource[] = new Array<RSSSource>()
        const groupsMap: Map<string, string> = new Map<string, string>()
        for (const feed of feeds) {
            const source = new RSSSource(feed.feed_url, feed.title)
            // associate service christened id to match in other request
            source.serviceRef = feed.id.toString()
            sources.push(source)
            groupsMap.set(feed.id.toString(), feed.category.title)
        }

        return [sources, configs.importGroups ? groupsMap : undefined]
    },

    // fetch entries from after the last fetched id (if exists)
    // limit by quantity and maximum safe integer (id)
    // NOTE: miniflux endpoint /entries default order with "published at", and does not offer "created_at"
    //          but does offer id sort, directly correlated with "created". some feeds give strange published_at.

    fetchItems: () => async (_, getState) => {
        const state = getState()
        const configs = state.service as MinifluxConfigs

        const queryParams = new URLSearchParams({
            order: "id",
            direction: "desc",
        })
        const items: Entry[] = await fetchEntries(configs, queryParams, true)

        // break/return nothing if no new items acquired
        if (items.length === 0) {
            return [[], configs]
        }
        configs.lastId = items[0].id

        // get sources that possess ref/id given by service, associate new items
        const sourceMap = new Map<string, RSSSource>()
        Object.values(state.sources).forEach(source => {
            if (source.serviceRef) {
                sourceMap.set(source.serviceRef, source)
            }
        })

        // map item objects to rssitem type while appling rules (if exist)
        const parsedItems = items.map(item => {
            const source = sourceMap.get(item.feed.id.toString())

            const parsedItem = {
                source: source.sid,
                title: item.title,
                link: item.url,
                date: new Date(item.published_at ?? item.created_at),
                fetchedDate: new Date(),
                content: item.content,
                snippet: htmlDecode(item.content).trim(),
                creator: item.author,
                hasRead: item.status === "read",
                starred: item.starred,
                hidden: false,
                notify: false,
                serviceRef: String(item.id),
                thumb: undefined,
            } as RSSItem

            // Try to get the thumbnail of the item
            const dom = new DOMParser().parseFromString(
                item.content,
                "text/html",
            )
            const baseEl = dom.createElement("base")
            baseEl.href = new URL(parsedItem.link).origin
            dom.head.append(baseEl)
            const img = dom.querySelector("img")
            if (img?.src) {
                parsedItem.thumb = img.src
            }

            if (source.rules) {
                SourceRule.applyAll(source.rules, parsedItem)
                if ((item.status === "read") !== parsedItem.hasRead) {
                    minifluxServiceHooks.markRead(parsedItem)
                }
                if (item.starred !== parsedItem.starred) {
                    minifluxServiceHooks.markUnread(parsedItem)
                }
            }

            return parsedItem
        })

        return [parsedItems, configs]
    },

    // get remote read and star state of articles, for local sync
    syncItems: () => async (_, getState) => {
        const configs = getState().service as MinifluxConfigs

        const queryParams = new URLSearchParams({
            status: "unread",
            order: "id",
            direction: "desc",
        })
        const unreadItems: Entry[] = await fetchEntries(configs, queryParams)

        queryParams.delete("status")
        queryParams.delete("before_entry_id")
        queryParams.append("starred", "true")
        const starredItems: Entry[] = await fetchEntries(configs, queryParams)

        return [
            new Set(unreadItems.map((entry: Entry) => String(entry.id))),
            new Set(starredItems.map((entry: Entry) => String(entry.id))),
        ]
    },

    markRead: (item: RSSItem) => async (_, getState) => {
        if (!item.serviceRef) {
            return
        }

        const body = `{
            "entry_ids": [${item.serviceRef}],
            "status": "read"
        }`

        const response = await fetchAPI(
            getState().service as MinifluxConfigs,
            "entries",
            "PUT",
            body,
        )

        if (response.status !== 204) {
            throw APIError()
        }
    },

    markUnread: (item: RSSItem) => async (_, getState) => {
        if (!item.serviceRef) {
            return
        }

        const body = `{
            "entry_ids": [${item.serviceRef}],
            "status": "unread"
        }`
        await fetchAPI(
            getState().service as MinifluxConfigs,
            "entries",
            "PUT",
            body,
        )
    },

    // mark entries for source ids as read, relative to date, determined by "before" bool

    // context menu component:
    // item - null, item date, either
    // group - group sources, null, true
    // nav - null, daysago, true

    // if null, state consulted for context sids

    markAllRead: (sids, date, before) => async (_, getState) => {
        const state = getState()
        const configs = state.service as MinifluxConfigs

        if (date) {
            const predicates: lf.Predicate[] = [
                db.items.source.in(sids),
                db.items.hasRead.eq(false),
                db.items.serviceRef.isNotNull(),
                before ? db.items.date.lte(date) : db.items.date.gte(date),
            ]
            const query = lf.op.and.apply(null, predicates)
            const rows = await db.itemsDB
                .select(db.items.serviceRef)
                .from(db.items)
                .where(query)
                .exec()
            const refs = rows.map(row => row["serviceRef"])
            const body = `{
                "entry_ids": [${refs}],
                "status": "read"
            }`
            await fetchAPI(configs, "entries", "PUT", body)
        } else {
            const { sources } = state
            await Promise.all(
                sids.map(sid =>
                    fetchAPI(
                        configs,
                        `feeds/${sources[sid]?.serviceRef}/mark-all-as-read`,
                        "PUT",
                    ),
                ),
            )
        }
    },

    star: (item: RSSItem) => async (_, getState) => {
        if (!item.serviceRef) {
            return
        }

        await fetchAPI(
            getState().service as MinifluxConfigs,
            `entries/${item.serviceRef}/bookmark`,
            "PUT",
        )
    },

    unstar: (item: RSSItem) => async (_, getState) => {
        if (!item.serviceRef) {
            return
        }

        await fetchAPI(
            getState().service as MinifluxConfigs,
            `entries/${item.serviceRef}/bookmark`,
            "PUT",
        )
    },
}

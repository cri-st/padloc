import { MongoClient, Db, Collection, CreateCollectionOptions, ObjectId, Filter, FindOptions } from "mongodb";
import { Storage, Storable, StorableConstructor, StorageListOptions, StorageQuery } from "@padloc/core/src/storage";
import { Err, ErrorCode } from "@padloc/core/src/error";
import path from "path";
import { Config, ConfigParam } from "@padloc/core/src/config";

export class MongoDBStorageConfig extends Config {
    @ConfigParam()
    host: string = "localhost";
    @ConfigParam("number")
    port: number = 27017;
    @ConfigParam()
    username: string = "";
    @ConfigParam("string", true)
    password: string = "";
    @ConfigParam()
    authDatabase?: string;
    @ConfigParam()
    database = "padloc";
    @ConfigParam()
    protocol?: string;
    @ConfigParam("boolean")
    tls?: boolean;
    @ConfigParam()
    tlsCAFile?: string;
    @ConfigParam("boolean")
    acknowledgeWrites: boolean = true;
    @ConfigParam("number")
    maxSize?: number;
    @ConfigParam("number")
    maxDocuments?: number;
}

// SECURITY: `query.op`/`query.path` come from client-controlled `StorageQuery`
// (via listAccounts/listOrgs, admin-gated but untrusted input). The previous
// `default` branch built `{[query.path]: {[\`$${query.op}\`]: query.value}}`
// from the raw, unvalidated `op` string, letting a caller inject ANY Mongo
// query operator (`$where`, `$expr`, ...) far beyond the six ops this
// builder is meant to support. `op` is now restricted to an explicit
// allowlist before it is ever used to build a `$`-prefixed key.
const ALLOWED_OPERATORS = new Set(["eq", "ne", "gt", "lt", "gte", "lte"]);

// SECURITY: same class of issue as packages/core/src/storage.ts's
// filterByQuery -- `query.value` here becomes a MongoDB `$regex`, and
// while MongoDB's own regex engine has some internal safeguards, an
// unbounded/catastrophic-backtracking-shaped pattern from an admin-gated
// but still client-controlled query is unnecessary risk. Same length cap
// + nested-quantifier heuristic as the core filter.
const MAX_REGEX_QUERY_PATTERN_LENGTH = 200;
const UNSAFE_REGEX_SHAPE = /\([^()]*[+*][^()]*\)[+*]/;

function assertSafeRegexPattern(pattern: unknown): asserts pattern is string {
    if (typeof pattern !== "string" || pattern.length > MAX_REGEX_QUERY_PATTERN_LENGTH) {
        throw new Err(ErrorCode.BAD_REQUEST, "Regex query pattern is invalid or too long.");
    }
    if (UNSAFE_REGEX_SHAPE.test(pattern)) {
        throw new Err(ErrorCode.BAD_REQUEST, "Regex query pattern rejected (potentially unsafe).");
    }
}

function queryToMongoFilter(query: StorageQuery): Filter<any> {
    switch (query.op) {
        case "and":
            return { $and: query.queries.map((q) => queryToMongoFilter(q)) };
        case "or":
            return { $or: query.queries.map((q) => queryToMongoFilter(q)) };
        case "not":
            return { $nor: [queryToMongoFilter(query.query)] };
        case "regex":
            assertSafeRegexPattern(query.value);
            return {
                [query.path]: {
                    $regex: query.value,
                    $options: "i",
                },
            };
        case "negex":
            assertSafeRegexPattern(query.value);
            return {
                [query.path]: {
                    $not: {
                        $regex: query.value,
                        $options: "i",
                    },
                },
            };
        case "eq":
        case undefined:
            return {
                [query.path]: query.value,
            };
        default:
            if (!ALLOWED_OPERATORS.has(query.op)) {
                throw new Err(ErrorCode.BAD_REQUEST, `Unsupported query operator: ${JSON.stringify(query.op)}`);
            }
            return {
                [query.path]: {
                    [`$${query.op}`]: query.value,
                },
            };
    }
}

export class MongoDBStorage implements Storage {
    readonly config: MongoDBStorageConfig;

    private _client: MongoClient;
    private _db!: Db;
    private _collections = new Map<string, Promise<Collection>>();

    constructor(config: MongoDBStorageConfig) {
        this.config = config;
        let { username, password, host, port, protocol = "mongodb", authDatabase, tls, tlsCAFile } = config;
        tlsCAFile = tlsCAFile && path.resolve(process.cwd(), tlsCAFile);
        // SECURITY: never log `password` (or the full config, which
        // contains it) in plaintext -- this used to be printed to
        // stdout/container logs on every startup.
        console.log(
            `Connecting to MongoDB at ${protocol}://${host}${authDatabase ? `/${authDatabase}` : ""}${
                port ? `:${port}` : ""
            } (user: ${username || "<none>"}, tls: ${!!tls})`
        );
        this._client = new MongoClient(
            `${protocol}://${host}${authDatabase ? `/${authDatabase}` : ""}${port ? `:${port}` : ""}`,
            {
                auth: username
                    ? {
                          username,
                          password,
                      }
                    : undefined,
                tls,
                tlsCAFile,
            }
        );
    }

    private async _getCollection(kind: string) {
        if (!this._collections.has(kind)) {
            this._collections.set(
                kind,
                new Promise(async (resolve, reject) => {
                    try {
                        const exists = await this._db.listCollections({ name: kind }).hasNext();

                        if (!exists) {
                            const opts: CreateCollectionOptions = {
                                writeConcern: { w: this.config.acknowledgeWrites ? 1 : -1 },
                            };
                            if (this.config.maxSize) {
                                opts.capped = true;
                                opts.size = this.config.maxSize;
                                opts.max = this.config.maxDocuments;
                            }
                            await this._db.createCollection(kind, opts);
                        }
                        resolve(this._db.collection(kind));
                    } catch (e) {
                        reject(e);
                    }
                })
            );
        }

        return this._collections.get(kind)!;
    }

    async init() {
        await this._client.connect();
        this._db = this._client.db(this.config.database);
    }

    async get<T extends Storable>(
        cls: StorableConstructor<T> | T,
        id: string,
        { useObjectId = false }: { useObjectId?: boolean } = {}
    ) {
        const res = cls instanceof Storable ? cls : new cls();
        const collection = await this._getCollection(res.kind);
        const raw = await collection.findOne({ _id: useObjectId ? new ObjectId(id) : id });
        if (!raw) {
            throw new Err(ErrorCode.NOT_FOUND, `Cannot find object: ${res.kind}_${id}`);
        }
        return res.fromRaw(raw);
    }

    async save<T extends Storable>(
        obj: T,
        {
            useObjectId = false,
            acknowledge = this.config.acknowledgeWrites,
        }: { useObjectId?: boolean; acknowledge?: boolean } = {}
    ) {
        const collection = await this._getCollection(obj.kind);
        const _id = useObjectId ? new ObjectId(obj.id) : obj.id;
        await collection.replaceOne(
            { _id },
            { ...obj.toRaw(), _id },
            { upsert: true, writeConcern: { w: acknowledge ? 1 : 0 } }
        );
    }

    async delete<T extends Storable>(obj: T, { useObjectId = false }: { useObjectId?: boolean } = {}) {
        const collection = await this._getCollection(obj.kind);
        await collection.deleteOne({ _id: useObjectId ? new ObjectId(obj.id) : obj.id });
    }

    async clear() {
        throw "not implemented";
    }

    async list<T extends Storable>(
        cls: StorableConstructor<T>,
        { offset, limit, query, orderBy, orderByDirection }: StorageListOptions = {}
    ): Promise<T[]> {
        const kind = new cls().kind;

        const collection = await this._getCollection(kind);
        const filter = query ? queryToMongoFilter(query) : {};
        const options = {
            limit,
            skip: offset,
        } as FindOptions;

        if (orderBy) {
            options.sort = {
                [orderBy]: orderByDirection === "desc" ? -1 : 1,
            };
        }

        const rows = await collection.find(filter, options).toArray();

        return rows.map((row) => new cls().fromRaw(row));
    }

    async count<T extends Storable>(cls: StorableConstructor<T>, query?: StorageQuery) {
        const kind = new cls().kind;
        const collection = await this._getCollection(kind);
        const filter = query ? queryToMongoFilter(query) : {};
        return collection.countDocuments(filter);
    }
}

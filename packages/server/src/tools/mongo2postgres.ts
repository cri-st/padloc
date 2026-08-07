import { readFileSync } from "fs";
import { MongoClient } from "mongodb";
import { resolve } from "path";
import { Pool } from "pg";
import { getConfig } from "../config";
import { MongoDBStorageConfig } from "../storage/mongodb";
import { PostgresConfig } from "../storage/postgres";

function getMongoClient(config: MongoDBStorageConfig) {
    let { username, password, host, port, protocol = "mongodb", database, tls, tlsCAFile } = config;
    tlsCAFile = tlsCAFile && resolve(process.cwd(), tlsCAFile);
    return new MongoClient(`${protocol}://${host}${database ? `/${database}` : ""}${port ? `:${port}` : ""}`, {
        auth: {
            username,
            password,
        },
        tls,
        tlsCAFile,
    });
}

function getPostgresPool(config: PostgresConfig) {
    const { host, user, password, port, database, tls, tlsCAFile, tlsCAFileContents, tlsRejectUnauthorized } = config;
    const tlsCAFilePath = tlsCAFile && resolve(process.cwd(), tlsCAFile);
    const ca = tlsCAFileContents || (tlsCAFilePath && readFileSync(tlsCAFilePath).toString());
    return new Pool({
        host,
        user,
        password,
        port,
        database,
        // SECURITY: mirrors `storage/postgres.ts`'s real backend -- this
        // one-shot migration tool previously hardcoded
        // `rejectUnauthorized: false` regardless of the operator's
        // `tlsRejectUnauthorized` config (which already defaults to
        // `true`), silently accepting any TLS certificate (including a
        // MITM'd one) for the Postgres connection this tool writes every
        // migrated account/vault/org to.
        ssl: tls
            ? {
                  rejectUnauthorized: tlsRejectUnauthorized,
                  ca,
              }
            : undefined,
    });
}

async function main() {
    const config = getConfig();
    // SECURITY: log the redacted `.toRaw()` form, never the raw Config
    // objects directly -- those contain `password` in plaintext, and
    // `secret: true` ConfigParams (see packages/core/src/config.ts) are
    // only redacted by `.toRaw()`, not by logging the instance itself.
    console.log("migrating data from mongodb to postgres. config: ", {
        mongodb: config.data.mongodb?.toRaw(),
        postgres: config.data.postgres?.toRaw(),
    });
    const mongoClient = getMongoClient(config.data.mongodb!);
    await mongoClient.connect();
    const mongo = mongoClient.db("padloc_data");
    const postgres = getPostgresPool(config.data.postgres!);

    for (const collName of ["account", "auth", "keystoreentry", "org", "provisioningentry", "session", "vault"]) {
        await postgres.query(
            `
                CREATE TABLE IF NOT EXISTS ${collName} (
                    id text PRIMARY KEY,
                    data jsonb NOT NULL
                )
            `
        );

        const entries = await mongo.collection(collName).find();
        let i = 0;
        const count = await entries.count();
        for await (const obj of entries) {
            i++;
            console.log(`copying ${collName} ${i}/${count}`);
            delete obj._id;
            await postgres.query(
                `
                INSERT INTO ${collName} (id, data) values($1, $2) ON CONFLICT (id) DO
                    UPDATE SET data=$2
            `,
                [obj.id, obj]
            );
        }
    }
}

main();

const testItem = {
    name: "Shared Login",
    username: "share-recipient@example.com",
    password: "SuperSecretSharePassword123!",
    url: "https://example.com",
};

const email = `${Math.floor(Math.random() * 1e8)}@example.com`;

describe("Share Link", () => {
    it("creates a one-time share link that a recipient can reveal exactly once", () => {
        cy.signup(email);

        // Create a Login item with a password field -- the only item type
        // `isShareableItem()` allows sharing (Req: Item-Type Scope).
        cy.doWithin(["pl-app", "pl-items", "pl-items-list"], () => cy.get("pl-button:eq(2)").click());
        cy.doWithin(["pl-app", "pl-create-item-dialog"], () => cy.get("footer pl-button.primary").click(), 100);

        cy.doWithin(
            ["pl-app", "pl-items", "pl-item-view"],
            () => {
                cy.typeWithin("pl-input#nameInput", testItem.name, { force: true });
                cy.doWithin(["pl-scroller pl-list pl-field:eq(0)"], () =>
                    cy.typeWithin("pl-input.value-input", testItem.username, { force: true })
                );
                cy.doWithin(["pl-scroller pl-list pl-field:eq(1)"], () =>
                    cy.typeWithin("pl-input.value-input", testItem.password, { force: true })
                );
                cy.doWithin(["pl-scroller pl-list pl-field:eq(2)"], () =>
                    cy.typeWithin("pl-input.value-input", testItem.url, { force: true })
                );
                cy.get("pl-button.primary").click();
            },
            500
        );

        cy.url().should("include", "/items/");
        cy.url().should("not.include", "/new");

        // "More Options" -> "Share Link ..." opens `pl-share-dialog`.
        cy.get('pl-item-view pl-button:has(pl-icon[icon="more"])').click({ force: true });
        cy.contains(".list-item", "Share Link").click({ force: true });

        cy.get("pl-share-dialog pl-select#ttlSelect", { timeout: 10000 }).should("be.visible");
        cy.get("pl-share-dialog pl-button#createButton").click({ force: true });

        // Creating the link encrypts the item client-side and calls the
        // real `createShare` RPC -- give it real network + crypto time.
        cy.get("pl-share-dialog pl-input", { timeout: 10000 }).should("be.visible");
        cy.get("pl-share-dialog pl-input")
            .find("input")
            .invoke("val")
            .then((link) => {
                const shareLink = String(link);
                expect(shareLink).to.include("/share/");
                expect(shareLink).to.include("#k=");

                // Switch to a fresh, anonymous session -- exactly what a
                // recipient with no Padloc account of their own does.
                cy.clearCookies();
                cy.clearLocalStorage();
                cy.clearIndexedDb();

                cy.visit(shareLink);

                cy.doWithin(
                    ["pl-app", "pl-share-view"],
                    () => {
                        cy.get("#revealButton", { timeout: 10000 }).should("be.visible").click({ force: true });
                    },
                    500
                );

                // Revealing decrypts client-side and calls `revealShare`,
                // which burns the link server-side exactly once.
                cy.doWithin(["pl-app", "pl-share-view"], () => {
                    cy.contains("h1", testItem.name, { timeout: 10000 }).should("be.visible");
                    cy.contains(".field-value", testItem.password).should("be.visible");
                    cy.contains(".field-value", testItem.username).should("be.visible");
                });

                // Reloading the exact same link (or a second recipient
                // opening it) must never reveal the secret again (Req:
                // Single-View Guarantee).
                cy.visit(shareLink);

                cy.doWithin(["pl-app", "pl-share-view"], () => {
                    cy.contains("h1", "Already Viewed", { timeout: 10000 }).should("be.visible");
                });
            });
    });
});

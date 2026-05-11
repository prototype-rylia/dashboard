/**
 * ═══════════════════════════════════════════════════════════════════
 *  RYLIA INVOICE ENGINE v2.0
 *  Moteur unifié de génération de factures micro-entrepreneur
 *
 *  v2.0 changelog :
 *  - Suppression du rond orange décoratif en haut à droite
 *  - Bloc paiement en gris clair (auparavant bleu pour virement / violet pour SEPA)
 *  - Multi-libellés : accepte un tableau d'items (description + qté + PU + remise)
 *  - Pagination "1/1", "1/2"... automatique
 *  - Période abonnement format "du JJ/MM/AAAA au JJ/MM/AAAA"
 *  - Footer ancré au bas de la page A4 (hauteur adaptative selon nb d'items)
 *  - Saut de ligne entre "Date de prélèvement" et mention italique (SEPA)
 *  - Correction des fautes (accentuation complète)
 * ═══════════════════════════════════════════════════════════════════
 */
(function(window) {
    "use strict";

    var RYLIA_ISSUER = {
        legalName:   "Cyrille THEMONT",
        tradeName:   "Rylia",
        statut:      "EI",
        tagline:     "Solutions digitales pour les professionnels",
        address:     "47 rue Vivienne",
        zip:         "75002",
        city:        "Paris",
        email:       "contact@rylia.fr",
        website:     "rylia.fr",
        siret:       "102 290 921 00018",
        rne:         "102 290 921",
        tvaMention:  "TVA non applicable, art. 293 B du CGI"
    };

    var RYLIA_PAYMENT = {
        titulaire: "Cyrille THEMONT",
        banque:    "",
        iban:      "",
        bic:       "",
        ics:       ""
    };

    var COLORS = {
        orange:     [255, 140, 0],
        dark:       [17, 24, 39],
        gray:       [107, 114, 128],
        grayBorder: [229, 231, 235],
        grayLight:  [249, 250, 251],
        grayMid:    [209, 213, 219],
        white:      [255, 255, 255]
    };

    async function getNextInvoiceNumber() {
        if (!window.firebase || !firebase.firestore) {
            throw new Error("Firebase non initialisé");
        }
        var db = firebase.firestore();
        return await db.runTransaction(async function(tx) {
            var ref = db.collection("users").doc("_settings");
            var doc = await tx.get(ref);
            var data = doc.exists ? doc.data() : {};
            var current = data.globalInvoiceCounter || 0;
            var next = current + 1;
            tx.set(ref, { globalInvoiceCounter: next }, { merge: true });
            return "F" + String(next).padStart(6, "0");
        });
    }

    function formatDateFR(date) {
        if (!date) return "";
        var d = date instanceof Date ? date : new Date(date);
        if (isNaN(d.getTime())) return "";
        var dd = String(d.getDate()).padStart(2, "0");
        var mm = String(d.getMonth() + 1).padStart(2, "0");
        return dd + "/" + mm + "/" + d.getFullYear();
    }

    function computeEcheance(dateEmission, delaiJours) {
        var d = new Date(dateEmission);
        d.setDate(d.getDate() + (delaiJours || 30));
        return d;
    }

    function getCurrentPeriode() {
        var n = new Date();
        return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0");
    }

    function getPeriodeLabel(periode) {
        var parts = periode.split("-");
        return new Date(parts[0], parseInt(parts[1]) - 1, 1)
            .toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    }

    /** "2026-04" -> "du 01/04/2026 au 30/04/2026" */
    function getPeriodeRangeLabel(periode) {
        var parts = periode.split("-");
        var year  = parseInt(parts[0]);
        var month = parseInt(parts[1]);
        var first = new Date(year, month - 1, 1);
        var last  = new Date(year, month, 0);
        return "du " + formatDateFR(first) + " au " + formatDateFR(last);
    }

    async function loadRyliaPaymentConfig() {
        try {
            var db = firebase.firestore();
            var snap = await db.collection("users").doc("_settings").get();
            if (snap.exists) {
                var data = snap.data();
                if (data.ryliaPayment) {
                    Object.assign(RYLIA_PAYMENT, data.ryliaPayment);
                }
            }
        } catch (e) {
            console.warn("loadRyliaPaymentConfig:", e);
        }
        return RYLIA_PAYMENT;
    }

    async function saveRyliaPaymentConfig(cfg) {
        var db = firebase.firestore();
        await db.collection("users").doc("_settings").set(
            { ryliaPayment: cfg },
            { merge: true }
        );
        Object.assign(RYLIA_PAYMENT, cfg);
    }

    function validateClientForInvoice(client, method) {
        var missing = [];
        var warnings = [];

        if (!client.companyName) missing.push("Raison sociale (companyName)");
        if (!client.email)       missing.push("Email");
        if (!client.address)     warnings.push("Adresse postale");
        if (!client.zip)         warnings.push("Code postal");
        if (!client.city)        warnings.push("Ville");
        if (!client.siret)       warnings.push("SIRET du client");

        if (method === "sepa") {
            var sepa = client.sepaMandate || {};
            if (!sepa.rum)         missing.push("RUM (Référence Unique de Mandat)");
            if (!sepa.mandateDate) missing.push("Date de signature du mandat SEPA");
            if (!sepa.clientIban)  missing.push("IBAN du client (compte débité)");
            if (!RYLIA_PAYMENT.ics) missing.push("ICS Rylia (à configurer dans les paramètres)");
        } else if (method === "virement") {
            if (!RYLIA_PAYMENT.iban) missing.push("IBAN Rylia (à configurer dans les paramètres)");
            if (!RYLIA_PAYMENT.bic)  missing.push("BIC Rylia (à configurer dans les paramètres)");
        }

        return { ok: missing.length === 0, missing: missing, warnings: warnings };
    }

    function _truncate(s, n) {
        s = String(s || "");
        return s.length > n ? s.substring(0, n - 1) + "…" : s;
    }

    function _maskIban(iban) {
        if (!iban) return "(manquant)";
        var s = String(iban).replace(/\s+/g, "");
        if (s.length < 8) return s;
        return s.substring(0, 4) + " •••• •••• •••• " + s.substring(s.length - 4);
    }

    function _formatIban(iban) {
        if (!iban) return "";
        var s = String(iban).replace(/\s+/g, "").toUpperCase();
        var matches = s.match(/.{1,4}/g);
        return matches ? matches.join(" ") : "";
    }

    function _paymentBlockHeight(method) {
        return method === "sepa" ? 44 : 28;
    }

    function _conditionsLines(method, delai) {
        if (method === "sepa") {
            return [
                "• Prélèvement automatique SEPA à la date indiquée, conformément au mandat signé.",
                "• En cas de rejet : pénalités de retard = 3 fois le taux d'intérêt légal en vigueur.",
                "• Indemnité forfaitaire de 40 € pour frais de recouvrement (art. L441-10 Code de commerce).",
                "• Pas d'escompte pour paiement anticipé.",
                "• Le client s'engage à notifier toute modification de ses coordonnées bancaires."
            ];
        }
        return [
            "• Règlement à " + delai + " jours à compter de la date d'émission.",
            "• Pénalités de retard : taux égal à 3 fois le taux d'intérêt légal en vigueur.",
            "• Indemnité forfaitaire de 40 € pour frais de recouvrement (art. L441-10 Code de commerce).",
            "• Pas d'escompte pour paiement anticipé.",
            "• Le code source et les livrables restent propriété de Rylia jusqu'au règlement intégral."
        ];
    }

    function generateInvoicePdf(params) {
        if (!window.jspdf) throw new Error("jsPDF non chargé");
        var jsPDF = window.jspdf.jsPDF;
        var doc = new jsPDF({ unit: "mm", format: "a4" });
        var W = 210, H = 297;

        var dateEmission = params.dateEmission || new Date();
        var delai = params.delaiJours || 30;
        var dateEcheance = params.dateEcheance || computeEcheance(dateEmission, delai);
        var datePrestation = params.datePrestation;
        var dateEmStr = formatDateFR(dateEmission);
        var dateEchStr = formatDateFR(dateEcheance);

        var items = (params.items || []).filter(function(it) { return it && it.description; });
        if (items.length === 0) throw new Error("Aucune ligne de prestation");

        var method = params.paymentMethod === "sepa" ? "sepa" : "virement";

        // ═══ HEADER ORANGE (sans rond décoratif) ═══
        doc.setFillColor.apply(doc, COLORS.orange);
        doc.rect(0, 0, W, 42, "F");

        doc.setFont("helvetica", "bold");
        doc.setFontSize(22); doc.setTextColor.apply(doc, COLORS.white);
        doc.text("RYLIA", 15, 18);
        doc.setFont("helvetica", "normal"); doc.setFontSize(9);
        doc.text(RYLIA_ISSUER.tagline, 15, 25);

        doc.setFont("helvetica", "bold"); doc.setFontSize(17);
        doc.text("FACTURE", W - 15, 17, { align: "right" });
        doc.setFontSize(12);
        doc.text("N° " + params.numero, W - 15, 25, { align: "right" });

        // Pagination
        var pageNum = params.pageNumber || 1;
        var pageTotal = params.pageTotal || 1;
        doc.setFont("helvetica", "normal"); doc.setFontSize(8);
        doc.text("Page " + pageNum + "/" + pageTotal, W - 15, 32, { align: "right" });

        // ═══ DATES (sous le header) ═══
        var y = 50;
        doc.setFont("helvetica", "normal"); doc.setFontSize(9);
        doc.setTextColor.apply(doc, COLORS.dark);
        doc.text("Date d'émission : " + dateEmStr, W - 15, y, { align: "right" });
        if (datePrestation) {
            y += 5;
            doc.text("Date de la prestation : " + formatDateFR(datePrestation), W - 15, y, { align: "right" });
        }
        y += 5;
        doc.setFont("helvetica", "bold");
        doc.text("Date d'échéance : " + dateEchStr, W - 15, y, { align: "right" });

        // ═══ BLOC ÉMETTEUR ═══
        var emY = 60;
        doc.setFont("helvetica", "bold"); doc.setFontSize(7);
        doc.setTextColor.apply(doc, COLORS.gray);
        doc.text("ÉMETTEUR", 15, emY);

        doc.setFont("helvetica", "bold"); doc.setFontSize(11);
        doc.setTextColor.apply(doc, COLORS.dark);
        doc.text(RYLIA_ISSUER.legalName + " — " + RYLIA_ISSUER.statut, 15, emY + 6);

        doc.setFont("helvetica", "italic"); doc.setFontSize(8);
        doc.setTextColor.apply(doc, COLORS.gray);
        doc.text("Entrepreneur Individuel (" + RYLIA_ISSUER.tradeName + ")", 15, emY + 11);

        doc.setFont("helvetica", "normal"); doc.setFontSize(9);
        var emLines = [
            RYLIA_ISSUER.address,
            RYLIA_ISSUER.zip + " " + RYLIA_ISSUER.city,
            RYLIA_ISSUER.email,
            "SIRET : " + RYLIA_ISSUER.siret,
            "RNE : " + RYLIA_ISSUER.rne
        ];
        emLines.forEach(function(line, i) { doc.text(line, 15, emY + 16 + i * 5); });
        doc.setFont("helvetica", "italic"); doc.setFontSize(8);
        doc.text(RYLIA_ISSUER.tvaMention, 15, emY + 16 + emLines.length * 5);

        // ═══ BLOC FACTURÉ À ═══
        var rx = W / 2 + 5, rw = W / 2 - 20;
        doc.setFillColor.apply(doc, COLORS.grayLight);
        doc.roundedRect(rx, emY - 3, rw, 55, 3, 3, "F");
        doc.setDrawColor.apply(doc, COLORS.grayBorder); doc.setLineWidth(0.3);
        doc.roundedRect(rx, emY - 3, rw, 55, 3, 3, "S");

        doc.setFont("helvetica", "bold"); doc.setFontSize(7);
        doc.setTextColor.apply(doc, COLORS.gray);
        doc.text("FACTURÉ À", rx + 5, emY);

        var c = params.client || {};
        doc.setFont("helvetica", "bold"); doc.setFontSize(11);
        doc.setTextColor.apply(doc, COLORS.dark);
        doc.text(_truncate(c.companyName || "—", 32), rx + 5, emY + 6);

        doc.setFont("helvetica", "normal"); doc.setFontSize(9);
        doc.setTextColor.apply(doc, COLORS.gray);
        var cLines = [];
        if (c.address) cLines.push(c.address);
        var cpV = [];
        if (c.zip)  cpV.push(c.zip);
        if (c.city) cpV.push(c.city);
        if (cpV.length) cLines.push(cpV.join(" "));
        if (c.email) cLines.push(c.email);
        if (c.phone) cLines.push("Tél : " + c.phone);
        if (c.siret) cLines.push("SIRET : " + c.siret);
        if (c.tvaIntra) cLines.push("N° TVA intra : " + c.tvaIntra);
        cLines.forEach(function(line, i) {
            doc.text(_truncate(line, 40), rx + 5, emY + 12 + i * 5);
        });

        // ═══ NATURE DE L'OPÉRATION ═══
        y = 118;
        doc.setFillColor.apply(doc, COLORS.grayLight);
        doc.rect(15, y, W - 30, 7, "F");
        doc.setDrawColor.apply(doc, COLORS.grayBorder); doc.setLineWidth(0.2);
        doc.rect(15, y, W - 30, 7, "S");
        doc.setFont("helvetica", "italic"); doc.setFontSize(9);
        doc.setTextColor.apply(doc, COLORS.dark);
        doc.text(
            "Nature de l'opération : Prestation de services — " + (params.natureDetail || "Programmation web"),
            18, y + 4.8
        );

        // ═══ TABLEAU PRESTATIONS ═══
        y += 13;
        var tableStartY = y;

        // Pré-calcul : chaque item fait 1 ligne, + 1 sous-ligne si periodeRange
        function _itemRowHeight(it) {
            return it.periodeRange ? 11 : 7;
        }
        var tableContentH = 0;
        items.forEach(function(it) { tableContentH += _itemRowHeight(it); });

        doc.setFillColor.apply(doc, COLORS.dark);
        doc.rect(15, y, W - 30, 8, "F");
        doc.setTextColor.apply(doc, COLORS.white);
        doc.setFont("helvetica", "bold"); doc.setFontSize(8);
        doc.text("DESCRIPTION",        18,      y + 5.3);
        doc.text("QTÉ",                 112,     y + 5.3, { align: "center" });
        doc.text("PRIX UNIT. HT",       145,     y + 5.3, { align: "right" });
        doc.text("REMISE",              168,     y + 5.3, { align: "right" });
        doc.text("TOTAL HT",            W - 18,  y + 5.3, { align: "right" });

        y += 8;
        var sousTotal = 0, remiseTotal = 0;
        doc.setFont("helvetica", "normal"); doc.setFontSize(9);
        items.forEach(function(it, idx) {
            var rowH = _itemRowHeight(it);
            var qte = it.qte || 1;
            var pu  = parseFloat(it.puHt) || 0;
            var rem = parseFloat(it.remise) || 0;
            var total = qte * pu - rem;
            sousTotal   += qte * pu;
            remiseTotal += rem;

            doc.setFillColor.apply(doc, idx % 2 === 0 ? COLORS.white : COLORS.grayLight);
            doc.rect(15, y, W - 30, rowH, "F");
            doc.setTextColor.apply(doc, COLORS.dark);
            doc.setFont("helvetica", "normal"); doc.setFontSize(9);
            doc.text(_truncate(it.description, 50),   18,     y + 4.7);
            doc.text(String(qte),                      112,    y + 4.7, { align: "center" });
            doc.text(pu.toFixed(2) + " €",             145,    y + 4.7, { align: "right" });
            doc.text(rem > 0 ? "-" + rem.toFixed(2) + " €" : "—", 168, y + 4.7, { align: "right" });
            doc.setFont("helvetica", "bold");
            doc.text(total.toFixed(2) + " €",          W - 18, y + 4.7, { align: "right" });

            // Sous-ligne "Période : du JJ/MM/AAAA au JJ/MM/AAAA" si présente
            if (it.periodeRange) {
                doc.setFont("helvetica", "italic"); doc.setFontSize(7.5);
                doc.setTextColor.apply(doc, COLORS.gray);
                doc.text("Période : " + it.periodeRange, 18, y + 8.8);
            }

            y += rowH;
        });

        doc.setDrawColor.apply(doc, COLORS.grayBorder); doc.setLineWidth(0.3);
        doc.rect(15, tableStartY, W - 30, 8 + tableContentH, "S");

        // ═══ TOTAUX ═══
        y += 5;
        var totalHT = sousTotal - remiseTotal;
        var totalsX = W - 80;

        doc.setFont("helvetica", "normal"); doc.setFontSize(9);
        doc.setTextColor.apply(doc, COLORS.gray);
        doc.text("Sous-total HT",           totalsX + 5, y);
        doc.setTextColor.apply(doc, COLORS.dark);
        doc.text(sousTotal.toFixed(2) + " €", W - 17, y, { align: "right" });

        y += 5;
        doc.setTextColor.apply(doc, COLORS.gray);
        doc.text("Remise totale",           totalsX + 5, y);
        doc.setTextColor.apply(doc, COLORS.dark);
        doc.text("-" + remiseTotal.toFixed(2) + " €", W - 17, y, { align: "right" });

        y += 5;
        doc.setTextColor.apply(doc, COLORS.gray);
        doc.text("Total HT",                totalsX + 5, y);
        doc.setTextColor.apply(doc, COLORS.dark);
        doc.setFont("helvetica", "bold");
        doc.text(totalHT.toFixed(2) + " €", W - 17, y, { align: "right" });

        y += 5;
        doc.setFont("helvetica", "italic"); doc.setFontSize(8);
        doc.setTextColor.apply(doc, COLORS.gray);
        doc.text("TVA non applicable, art. 293 B du CGI", W - 17, y, { align: "right" });

        y += 4;
        doc.setFillColor.apply(doc, COLORS.orange);
        doc.roundedRect(totalsX, y, 75, 11, 3, 3, "F");
        doc.setTextColor.apply(doc, COLORS.white);
        doc.setFont("helvetica", "bold"); doc.setFontSize(10);
        doc.text("NET À PAYER", totalsX + 5, y + 7);
        doc.setFontSize(13);
        doc.text(totalHT.toFixed(2) + " €", W - 17, y + 7.5, { align: "right" });

        // ═══════════════════════════════════════════════════════
        //   FOOTER ANCRÉ EN BAS (H - 18)
        //   Calcul de la position du bloc paiement EN PARTANT DU BAS
        //   pour que l'espace se compresse quand le tableau grossit
        // ═══════════════════════════════════════════════════════
        var footerH = 18;
        var footerTopY = H - footerH;
        var conditionsLines = _conditionsLines(method, delai);
        var conditionsH = 5 + conditionsLines.length * 4;
        var noteH = params.note ? 6 : 0;
        var paymentH = _paymentBlockHeight(method);
        var paymentGap = 4;
        var paymentTopY = footerTopY - noteH - conditionsH - paymentH - paymentGap;

        // Vérifie qu'il reste assez d'espace sous les totaux
        // y = bas du bandeau "Net à payer" après les blocs ci-dessus
        var minGap = 6;   // espace minimum entre "Net à payer" et bloc paiement
        if (y + 11 + minGap > paymentTopY) {
            throw new Error(
                "Contenu trop long pour tenir sur une page A4. " +
                "Réduisez le nombre de lignes de prestations (max conseillé : 6 lignes simples, " +
                "ou 4 lignes avec période)."
            );
        }

        _renderPaymentBlock(doc, params, paymentTopY, W, method);

        var condY = paymentTopY + paymentH + 5;
        doc.setFont("helvetica", "bold"); doc.setFontSize(8);
        doc.setTextColor.apply(doc, COLORS.gray);
        doc.text("CONDITIONS DE PAIEMENT", 15, condY);

        doc.setFont("helvetica", "normal"); doc.setFontSize(7.5);
        doc.setTextColor.apply(doc, COLORS.gray);
        conditionsLines.forEach(function(line, i) {
            doc.text(line, 15, condY + 4 + i * 4);
        });

        if (params.note) {
            var noteY = condY + 4 + conditionsLines.length * 4 + 2;
            doc.setFont("helvetica", "italic"); doc.setFontSize(7.5);
            doc.text("Note : " + _truncate(params.note, 110), 15, noteY);
        }

        // ═══ FOOTER SOMBRE ═══
        doc.setFillColor.apply(doc, COLORS.dark);
        doc.rect(0, footerTopY, W, footerH, "F");
        doc.setFont("helvetica", "normal"); doc.setFontSize(7.2);
        doc.setTextColor(156, 163, 175);
        doc.text(
            RYLIA_ISSUER.legalName + " " + RYLIA_ISSUER.statut + " — " +
            RYLIA_ISSUER.address + ", " + RYLIA_ISSUER.zip + " " + RYLIA_ISSUER.city,
            W / 2, H - 12, { align: "center" }
        );
        doc.text(
            "SIRET " + RYLIA_ISSUER.siret + " — RNE " + RYLIA_ISSUER.rne + " — " + RYLIA_ISSUER.tvaMention,
            W / 2, H - 7, { align: "center" }
        );
        doc.text(
            "Document généré automatiquement le " + dateEmStr + " — " + RYLIA_ISSUER.website,
            W / 2, H - 2, { align: "center" }
        );

        return doc.output("datauristring").split(",")[1];
    }

    function _renderPaymentBlock(doc, params, y, W, method) {
        var height = _paymentBlockHeight(method);
        var title  = method === "sepa" ? "RÈGLEMENT PAR PRÉLÈVEMENT SEPA" : "RÈGLEMENT PAR VIREMENT BANCAIRE";

        doc.setFillColor.apply(doc, COLORS.grayLight);
        doc.roundedRect(15, y, W - 30, height, 3, 3, "F");
        doc.setDrawColor.apply(doc, COLORS.grayMid); doc.setLineWidth(0.3);
        doc.roundedRect(15, y, W - 30, height, 3, 3, "S");

        doc.setFont("helvetica", "bold"); doc.setFontSize(9);
        doc.setTextColor.apply(doc, COLORS.dark);
        doc.text(title, 18, y + 5.5);

        doc.setFont("helvetica", "normal"); doc.setFontSize(8);
        var rows;
        if (method === "sepa") {
            var m = params.sepaMandate || {};
            rows = [
                ["Créancier",           (RYLIA_ISSUER.legalName + " (" + RYLIA_ISSUER.tradeName + ")")],
                ["ICS",                 RYLIA_PAYMENT.ics || "(non configuré)"],
                ["RUM",                 m.rum || "(manquant)"],
                ["Mandat signé le",     m.mandateDate ? formatDateFR(m.mandateDate) : "(manquant)"],
                ["IBAN débité",         _maskIban(m.clientIban || "")],
                ["Type de prélèvement", m.typePrelevement || "RCUR"],
                ["Date de prélèvement", m.datePrelevement ? formatDateFR(m.datePrelevement) : formatDateFR(params.dateEcheance)]
            ];
        } else {
            rows = [
                ["Titulaire",       RYLIA_PAYMENT.titulaire || RYLIA_ISSUER.legalName],
                ["Banque",          RYLIA_PAYMENT.banque || "(non configuré)"],
                ["IBAN",            _formatIban(RYLIA_PAYMENT.iban) || "(non configuré)"],
                ["BIC",             RYLIA_PAYMENT.bic || "(non configuré)"],
                ["Référence",       params.numero]
            ];
        }

        var labelX = 20, valX = 60;
        rows.forEach(function(row, i) {
            var ry = y + 10 + i * 4;
            doc.setTextColor.apply(doc, COLORS.gray);
            doc.text(row[0], labelX, ry);
            doc.setFont("helvetica", "bold");
            doc.setTextColor.apply(doc, COLORS.dark);
            doc.text(row[1], valX, ry);
            doc.setFont("helvetica", "normal");
        });

        if (method === "sepa") {
            // Saut de ligne entre "Date de prélèvement" et mention italique
            var italicY = y + 10 + rows.length * 4 + 5;
            doc.setFont("helvetica", "italic"); doc.setFontSize(7.5);
            doc.setTextColor.apply(doc, COLORS.gray);
            doc.text(
                "Facture prélevée automatiquement à la date indiquée, conformément au mandat signé. Aucune action requise.",
                18, italicY
            );
        }
    }

    window.RyliaInvoice = {
        VERSION:              "2.0",
        ISSUER:               RYLIA_ISSUER,
        PAYMENT:              RYLIA_PAYMENT,
        getNextInvoiceNumber: getNextInvoiceNumber,
        generateInvoicePdf:   generateInvoicePdf,
        validateClient:       validateClientForInvoice,
        loadPaymentConfig:    loadRyliaPaymentConfig,
        savePaymentConfig:    saveRyliaPaymentConfig,
        formatDateFR:         formatDateFR,
        computeEcheance:      computeEcheance,
        getCurrentPeriode:    getCurrentPeriode,
        getPeriodeLabel:      getPeriodeLabel,
        getPeriodeRangeLabel: getPeriodeRangeLabel,
        maskIban:             _maskIban,
        formatIban:           _formatIban
    };

})(window);
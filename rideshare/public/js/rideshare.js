/* Rideshare — shared client helpers.
 *
 * Exposes window.rs with:
 *   rs.api(method, args)         -> Promise of frappe.call result
 *   rs.toast(msg, type)
 *   rs.fmtMoney(n)
 *   rs.fmtDateTime(s)
 *   rs.cityAutocomplete(input)
 */
(function () {
  "use strict";

  const rs = (window.rs = {});

  rs.api = function (method, args = {}) {
    return new Promise((resolve, reject) => {
      frappe.call({
        method: method,
        args: args,
        callback: (r) => resolve(r.message),
        error: (err) => reject(err),
      });
    });
  };

  rs.toast = function (msg, type = "") {
    let el = document.querySelector(".rs-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "rs-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = "rs-toast show " + type;
    clearTimeout(rs._toastT);
    rs._toastT = setTimeout(() => {
      el.className = "rs-toast";
    }, 2800);
  };

  rs.fmtMoney = function (n, currency = "INR") {
    if (n == null || isNaN(n)) return "";
    const sym = currency === "INR" ? "₹" : currency + " ";
    return sym + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  };

  rs.fmtDateTime = function (s) {
    if (!s) return "";
    const d = new Date(s.replace(" ", "T"));
    if (isNaN(d)) return s;
    return d.toLocaleString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  rs.fmtTime = function (s) {
    if (!s) return "";
    const d = new Date(s.replace(" ", "T"));
    if (isNaN(d)) return s;
    return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  };

  rs.fmtDate = function (s) {
    if (!s) return "";
    const d = new Date(s.replace(" ", "T"));
    if (isNaN(d)) return s;
    return d.toLocaleDateString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  };

  /**
   * Attach a city <datalist> autocomplete to a text input.
   * Uses ``rideshare.api.rides.list_cities_public``.
   */
  rs.cityAutocomplete = function (input) {
    if (!input) return;
    const listId = "rs-city-list-" + Math.random().toString(36).slice(2, 8);
    const list = document.createElement("datalist");
    list.id = listId;
    document.body.appendChild(list);
    input.setAttribute("list", listId);

    const fill = (rows) => {
      list.innerHTML = "";
      rows.forEach((r) => {
        const opt = document.createElement("option");
        opt.value = r.label;
        list.appendChild(opt);
      });
    };

    let t;
    input.addEventListener("input", () => {
      clearTimeout(t);
      const q = input.value;
      t = setTimeout(() => {
        rs.api("rideshare.api.rides.list_cities_public", { query: q, limit: 12 })
          .then(fill)
          .catch(() => {});
      }, 120);
    });
    input.addEventListener("focus", () => {
      rs.api("rideshare.api.rides.list_cities_public", { query: "", limit: 12 })
        .then(fill)
        .catch(() => {});
    });
  };

  rs.requireLogin = function () {
    if (frappe.session && frappe.session.user && frappe.session.user !== "Guest") return true;
    window.location.href = "/rideshare/login?next=" + encodeURIComponent(window.location.pathname + window.location.search);
    return false;
  };
})();

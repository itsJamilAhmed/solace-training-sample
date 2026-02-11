/*jslint es6 browser devel:true*/
/*global solace, window, document, requestAnimationFrame*/

(function () {
  'use strict';

  var pubsub = {};
  pubsub.session = null;

  pubsub.state = {
    connected: false,
    connecting: false
  };

  pubsub.uiFlags = {
    firstSubExpansionsDone: false
  };

  pubsub.anim = {
    durationMs: 340,     // Gentle
    easing: 'ease',
    isAnimating: {}      // map of detailsId -> boolean
  };

  // subscriptions[pattern] = {
  //   state: 'pending_add'|'active'|'pending_remove'|'inactive'|'error'|'disconnected',
  //   lastError?: string,
  //   msgCount?: number,
  //   lastReceivedTs?: number
  // }
  pubsub.subscriptions = {};

  pubsub.init = function () {
    var factoryProps = new solace.SolclientFactoryProperties();
    factoryProps.profile = solace.SolclientFactoryProfiles.version10_5;
    solace.SolclientFactory.init(factoryProps);
    solace.SolclientFactory.setLogLevel(solace.LogLevel.WARN);

    document.getElementById('connectToggle').addEventListener('click', pubsub.connectToggle);
    document.getElementById('publish').addEventListener('click', pubsub.publish);
    document.getElementById('addSub').addEventListener('click', pubsub.addSubscriptionFromInput);

    // Publish style selector (Basic / Advanced)
    var styleEls = document.getElementsByName('publishStyle');
    for (var si = 0; si < styleEls.length; si += 1) {
      styleEls[si].addEventListener('change', function () { pubsub.togglePublishStyle(); });
    }

    // Topic builder controls (advanced mode)
    var clearBtn = document.getElementById('clearTopicBuilder');
    if (clearBtn) { clearBtn.addEventListener('click', function () { pubsub.clearTopicBuilder(); }); }
    var resetBtn = document.getElementById('resetTopicBuilder');
    if (resetBtn) { resetBtn.addEventListener('click', function () { pubsub.resetTopicBuilderToDefaults(); }); }

    // Live update of generated topic as inputs change
    var tbIds = ['tbDomain', 'tbNoun', 'tbVerb', 'tbProp1', 'tbProp2', 'tbProp3'];
    tbIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', function () { pubsub.generateTopicFromBuilder(false); });
      }
    });

    // When style toggles, show/hide the corresponding blocks
    // Ensure initial visibility is correct
    pubsub.togglePublishStyle();

    var clearLogBtn = document.getElementById('clearLog');
    if (clearLogBtn) {
      clearLogBtn.addEventListener('click', pubsub.clearLog);
    }

    var clearMessagesBtn = document.getElementById('clearMessages');
    if (clearMessagesBtn) {
      clearMessagesBtn.addEventListener('click', pubsub.clearMessages);
    }

    // Delegate actions from the subscription table (Toggle Subscribe / Delete)
    document.getElementById('subsTbody').addEventListener('click', function (e) {
      var target = e.target;
      if (!target || target.tagName !== 'BUTTON') {
        return;
      }
      var action = target.getAttribute('data-action');
      var pattern = target.getAttribute('data-pattern');

      if (action === 'toggle') {
        pubsub.toggleSubscription(pattern);
      } else if (action === 'delete') {
        pubsub.deleteSubscription(pattern);
      }
    });

    pubsub.enableSmoothDetails();
    pubsub.togglePublishStyle();

    var initialTopicDefaults = pubsub.getTopicBuilderDefaults();
    pubsub.applyTopicBuilderValues(initialTopicDefaults);
    pubsub.syncAdvancedPayloadFromTopicDefaults(initialTopicDefaults);

    pubsub.updateUi();
    pubsub.renderSubscriptions();

    pubsub.setStatus('info', 'Disconnected', 'Enter your broker details in Step 1, then click Connect.');
    pubsub.clearSubStatus();
    pubsub.clearPubStatus();
    pubsub.log('Ready. Enter broker details, then Connect.');
  };

  pubsub.getDetailsBody = function (detailsEl) {
    if (!detailsEl) {
      return null;
    }
    return detailsEl.querySelector('.card-body');
  };

  pubsub.setBodyTransition = function (body, enable) {
    if (!body) {
      return;
    }
    if (enable) {
      body.style.transition = 'height ' + pubsub.anim.durationMs + 'ms ' + pubsub.anim.easing;
    } else {
      body.style.transition = '';
    }
  };

  pubsub.animateOpen = function (detailsEl) {
    var body = pubsub.getDetailsBody(detailsEl);
    if (!detailsEl || !body) {
      return;
    }

    var id = detailsEl.id || '';
    if (id && pubsub.anim.isAnimating[id]) {
      return;
    }
    if (id) {
      pubsub.anim.isAnimating[id] = true;
    }

    // Ensure open so content has layout
    detailsEl.open = true;

    // Start from 0, animate to scrollHeight
    pubsub.setBodyTransition(body, false);
    body.style.height = '0px';

    // Force reflow
    body.getBoundingClientRect();

    var targetHeight = body.scrollHeight;

    pubsub.setBodyTransition(body, true);
    requestAnimationFrame(function () {
      body.style.height = targetHeight + 'px';
    });

    body.addEventListener('transitionend', function onEnd(e) {
      if (e.propertyName !== 'height') {
        return;
      }
      body.removeEventListener('transitionend', onEnd);
      pubsub.setBodyTransition(body, false);
      body.style.height = 'auto';
      if (id) {
        pubsub.anim.isAnimating[id] = false;
      }
    });
  };

  pubsub.animateClose = function (detailsEl) {
    var body = pubsub.getDetailsBody(detailsEl);
    if (!detailsEl || !body) {
      return;
    }

    var id = detailsEl.id || '';
    if (id && pubsub.anim.isAnimating[id]) {
      return;
    }
    if (id) {
      pubsub.anim.isAnimating[id] = true;
    }

    pubsub.setBodyTransition(body, false);

    var currentHeight = body.scrollHeight;
    body.style.height = currentHeight + 'px';

    body.getBoundingClientRect();

    pubsub.setBodyTransition(body, true);
    requestAnimationFrame(function () {
      body.style.height = '0px';
    });

    body.addEventListener('transitionend', function onEnd(e) {
      if (e.propertyName !== 'height') {
        return;
      }
      body.removeEventListener('transitionend', onEnd);
      pubsub.setBodyTransition(body, false);
      detailsEl.open = false;
      body.style.height = '0px';
      if (id) {
        pubsub.anim.isAnimating[id] = false;
      }
    });
  };

  pubsub.enableSmoothDetails = function () {
    var details = document.querySelectorAll('details.card');
    var i;

    for (i = 0; i < details.length; i += 1) {
      (function (d) {
        var body = pubsub.getDetailsBody(d);
        var summary = d.querySelector('summary');
        if (!body || !summary) {
          return;
        }

        pubsub.setBodyTransition(body, false);
        if (d.open) {
          body.style.height = 'auto';
        } else {
          body.style.height = '0px';
        }

        summary.addEventListener('click', function (e) {
          e.preventDefault();
          if (d.open) {
            pubsub.animateClose(d);
          } else {
            pubsub.animateOpen(d);
          }
        });
      }(details[i]));
    }
  };

  pubsub.openDetails = function (id) {
    var el = document.getElementById(id);
    if (el && !el.open) {
      pubsub.animateOpen(el);
    }
  };

  pubsub.closeDetails = function (id) {
    var el = document.getElementById(id);
    if (el && el.open) {
      pubsub.animateClose(el);
    }
  };

  // Step 2 (connection) banner
  pubsub.setStatus = function (level, title, hint) {
    var banner = document.getElementById('statusBanner');
    var titleEl = document.getElementById('statusTitle');
    var hintEl = document.getElementById('statusHint');

    if (!banner || !titleEl || !hintEl) {
      return;
    }

    banner.className = 'status-banner ' + (
      level === 'success' ? 'status-success' :
      level === 'warn' ? 'status-warn' :
      level === 'error' ? 'status-error' :
      'status-info'
    );

    titleEl.textContent = title || '';
    hintEl.textContent = hint || '';
  };

  // Step 3 banner
  pubsub.setSubStatus = function (level, title, hint) {
    var banner = document.getElementById('subStatusBanner');
    var titleEl = document.getElementById('subStatusTitle');
    var hintEl = document.getElementById('subStatusHint');

    if (!banner || !titleEl || !hintEl) {
      return;
    }

    banner.className = 'status-banner section-status ' + (
      level === 'success' ? 'status-success' :
      level === 'warn' ? 'status-warn' :
      level === 'error' ? 'status-error' :
      'status-info'
    );

    titleEl.textContent = title || '';
    hintEl.textContent = hint || '';
    banner.classList.remove('is-hidden');
  };

  pubsub.clearSubStatus = function () {
    var banner = document.getElementById('subStatusBanner');
    var titleEl = document.getElementById('subStatusTitle');
    var hintEl = document.getElementById('subStatusHint');

    if (!banner || !titleEl || !hintEl) {
      return;
    }

    titleEl.textContent = '';
    hintEl.textContent = '';
    if (!banner.classList.contains('is-hidden')) {
      banner.classList.add('is-hidden');
    }
  };

  // Step 4 banner
  pubsub.setPubStatus = function (level, title, hint) {
    var banner = document.getElementById('pubStatusBanner');
    var titleEl = document.getElementById('pubStatusTitle');
    var hintEl = document.getElementById('pubStatusHint');

    if (!banner || !titleEl || !hintEl) {
      return;
    }

    banner.className = 'status-banner section-status ' + (
      level === 'success' ? 'status-success' :
      level === 'warn' ? 'status-warn' :
      level === 'error' ? 'status-error' :
      'status-info'
    );

    titleEl.textContent = title || '';
    hintEl.textContent = hint || '';
    banner.classList.remove('is-hidden');
  };

  pubsub.togglePublishStyle = function () {
    var adv = document.getElementById('advancedOptions');
    var sel = document.querySelector('input[name="publishStyle"]:checked');
    if (!adv || !sel) { return; }
    var basic = document.getElementById('basicOptions');
    if (sel.value === 'advanced') {
      adv.classList.remove('is-hidden');
      if (basic) { basic.classList.add('is-hidden'); }
      // when advanced opens, ensure generated topic reflects current builder
      pubsub.generateTopicFromBuilder(false);
    } else {
      if (!adv.classList.contains('is-hidden')) { adv.classList.add('is-hidden'); }
      if (basic) { basic.classList.remove('is-hidden'); }
      // when switching to basic, hide suggestions
      pubsub.updatePubSubSuggestions();
    }
  };

  pubsub.generateTopicFromBuilder = function (setToPubTopic) {
    if (setToPubTopic === undefined) { setToPubTopic = false; }
    var parts = [];
    ['tbDomain', 'tbNoun', 'tbVerb', 'tbProp1', 'tbProp2', 'tbProp3'].forEach(function (id) {
      var v = document.getElementById(id);
      if (v && v.value && v.value.trim()) {
        parts.push(v.value.trim());
      }
    });
    var topic = parts.join('/');
    var genEl = document.getElementById('generatedTopic');
    if (genEl) { genEl.value = topic; }
    if (setToPubTopic) {
      var pubEl = document.getElementById('pubTopic');
      if (pubEl) { pubEl.value = topic; }
    }
    pubsub.updatePubSubSuggestions();
  };

  pubsub.getTopicBuilderDefaults = function () {
    var navLang = (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US';
    var parts = String(navLang).split(/[-_]/);
    var languageCode = (parts[0] || 'en').toLowerCase();
    var regionCode = (parts[1] || 'US').toUpperCase();
    var languageLong = languageCode;
    var tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions) ? (Intl.DateTimeFormat().resolvedOptions().timeZone || '') : '';

    var countryLong = regionCode;
    try {
      if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
        var regionDisplay = new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' });
        var regionName = regionDisplay.of(regionCode);
        if (regionName) {
          countryLong = regionName;
        }

        var languageDisplay = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
        var languageName = languageDisplay.of(languageCode);
        if (languageName) {
          languageLong = languageName;
        }
      }
    } catch (e) { /* ignore */ }

    var countryKebab = String(countryLong)
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-');
    var languageKebab = String(languageLong)
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-');

    var randomNumber = String(Math.floor(Math.random() * 9999) + 1).padStart(4, '0');

    return {
      tbDomain: 'workshop',
      tbNoun: 'hello-message',
      tbVerb: 'announced',
      tbProp1: countryKebab || 'united-states',
      tbProp2: languageKebab || 'english',
      tbProp3: randomNumber,
      countryLong: countryLong,
      languageLong: languageLong,
      timezone: tz
    };
  };

  pubsub.applyTopicBuilderValues = function (values) {
    ['tbDomain', 'tbNoun', 'tbVerb', 'tbProp1', 'tbProp2', 'tbProp3'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && values && Object.prototype.hasOwnProperty.call(values, id)) {
        el.value = values[id];
      }
    });
    pubsub.generateTopicFromBuilder(false);
  };

  pubsub.resetTopicBuilderToDefaults = function () {
    var defaults = pubsub.getTopicBuilderDefaults();
    pubsub.applyTopicBuilderValues(defaults);
    pubsub.syncAdvancedPayloadExistingFieldsFromTopicDefaults(defaults);
  };

  pubsub.syncAdvancedPayloadFromTopicDefaults = function (defaults) {
    var payloadEl = document.getElementById('payloadAdvanced');
    if (!payloadEl || !defaults) {
      return;
    }

    var cur = payloadEl.value.trim();
    var obj = null;
    try {
      obj = cur ? JSON.parse(cur) : {};
    } catch (e) {
      obj = {};
    }
    if (!obj || typeof obj !== 'object') {
      obj = {};
    }

    if (defaults.countryLong) {
      obj.country = defaults.countryLong;
    }
    if (defaults.languageLong) {
      obj.language = defaults.languageLong;
    }
    if (defaults.timezone) {
      obj.timezone = defaults.timezone;
    }
    if (defaults.tbProp3) {
      obj.msgId = defaults.tbProp3;
    }

    try {
      obj.timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    } catch (e2) { /* ignore */ }

    payloadEl.value = JSON.stringify(obj, null, 2);
  };

  pubsub.syncAdvancedPayloadExistingFieldsFromTopicDefaults = function (defaults) {
    var payloadEl = document.getElementById('payloadAdvanced');
    if (!payloadEl || !defaults) {
      return;
    }

    var obj;
    try {
      obj = JSON.parse(payloadEl.value);
    } catch (e) {
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(obj, 'country') && defaults.countryLong) {
      obj.country = defaults.countryLong;
    }
    if (Object.prototype.hasOwnProperty.call(obj, 'language') && defaults.languageLong) {
      obj.language = defaults.languageLong;
    }
    if (Object.prototype.hasOwnProperty.call(obj, 'timezone') && defaults.timezone) {
      obj.timezone = defaults.timezone;
    }
    if (Object.prototype.hasOwnProperty.call(obj, 'msgId') && defaults.tbProp3) {
      obj.msgId = defaults.tbProp3;
    }
    if (Object.prototype.hasOwnProperty.call(obj, 'timestamp')) {
      try {
        obj.timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      } catch (e2) { /* ignore */ }
    }

    payloadEl.value = JSON.stringify(obj, null, 2);
  };

  pubsub.clearTopicBuilder = function () {
    ['tbDomain','tbNoun', 'tbVerb', 'tbProp1', 'tbProp2', 'tbProp3', 'generatedTopic'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { el.value = ''; }
    });
    pubsub.updatePubSubSuggestions();
  };

  pubsub.updatePubSubSuggestions = function () {
    var suggestionsEl = document.getElementById('pubSubSuggestions');
    var suggestionsLabelEl = document.getElementById('pubSubSuggestionsLabel');
    if (!suggestionsEl) { return; }

    // Get values from builder fields
    var domain = document.getElementById('tbDomain').value.trim();
    var noun = document.getElementById('tbNoun').value.trim();
    var verb = document.getElementById('tbVerb').value.trim();
    var prop1 = document.getElementById('tbProp1').value.trim();
    var prop3 = document.getElementById('tbProp3').value.trim();

    // Check if Advanced mode is active and fields are not empty
    var isAdvanced = document.querySelector('input[name="publishStyle"]:checked').value === 'advanced';
    var hasFields = domain || noun || verb || prop1;

    // Clear suggestions
    while (suggestionsEl.firstChild) {
      suggestionsEl.removeChild(suggestionsEl.firstChild);
    }

    if (!isAdvanced || !hasFields) {
      suggestionsEl.style.display = 'none';
      if (suggestionsLabelEl) { suggestionsLabelEl.style.display = 'none'; }
      return;
    }

    // Generate three suggested patterns
    var suggestions = [];
    if (domain) {
      suggestions.push(domain + '/>');
    }
    if (domain && noun && prop1) {
      suggestions.push(domain + '/' + noun + '/*/' + prop1 + '/*/*');
    }
    if (domain && noun && verb) {
      suggestions.push(domain + '/' + noun + '/' + verb + '/>');
    }
    if (domain && noun && prop3) {
      suggestions.push(domain + '/' + noun + '/*/*/*/' + prop3);
    }

    // Render pills
    suggestionsEl.style.display = suggestions.length > 0 ? 'flex' : 'none';
    if (suggestionsLabelEl) {
      suggestionsLabelEl.style.display = suggestions.length > 0 ? 'block' : 'none';
    }
    suggestions.forEach(function (pattern) {
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'pub-sub-suggestion';
      pill.textContent = pattern;
      pill.addEventListener('click', function (e) {
        e.preventDefault();
        var subTopicEl = document.getElementById('subTopic');
        if (subTopicEl) {
          subTopicEl.value = pattern;
          // Optional: auto-focus the Add Subscription button to encourage action
          var addSubBtn = document.getElementById('addSub');
          if (addSubBtn) { addSubBtn.focus(); }
        }
      });
      suggestionsEl.appendChild(pill);
    });
  };

  pubsub.clearPubStatus = function () {
    var banner = document.getElementById('pubStatusBanner');
    var titleEl = document.getElementById('pubStatusTitle');
    var hintEl = document.getElementById('pubStatusHint');

    if (!banner || !titleEl || !hintEl) {
      return;
    }

    titleEl.textContent = '';
    hintEl.textContent = '';
    if (!banner.classList.contains('is-hidden')) {
      banner.classList.add('is-hidden');
    }
  };

  pubsub.normalizePattern = function (s) {
    if (typeof s !== 'string') {
      return '';
    }
    return s.trim().replace(/\s+/g, '');
  };

  pubsub.statusLabel = function (state) {
    if (state === 'pending_add') { return 'Subscribing…'; }
    if (state === 'active') { return 'Subscribed'; }
    if (state === 'pending_remove') { return 'Unsubscribing…'; }
    if (state === 'inactive') { return 'Unsubscribed'; }
    if (state === 'disconnected') { return 'Not Active (Disconnected)'; }
    if (state === 'error') { return 'Error'; }
    return 'Unknown';
  };

  pubsub.formatTime = function (ts) {
    if (!ts) {
      return '—';
    }
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' +
      ('0' + d.getMinutes()).slice(-2) + ':' +
      ('0' + d.getSeconds()).slice(-2);
  };

  pubsub.tryPrettyJson = function (value) {
    if (typeof value !== 'string') {
      return String(value);
    }

    var s = value.trim();
    if (!s) {
      return '';
    }

    var startsOk = (s.charAt(0) === '{' && s.charAt(s.length - 1) === '}') ||
                   (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']');
    if (!startsOk) {
      return value;
    }

    try {
      var obj = JSON.parse(s);
      return JSON.stringify(obj, null, 2);
    } catch (e) {
      return value;
    }
  };

  pubsub.appendMessage = function (topic, payload) {
    var el = document.getElementById('messages');
    var nowTs = Date.now();

    var pretty = pubsub.tryPrettyJson(payload);
    var ts = pubsub.formatTime(nowTs);

    if (!el) {
      pubsub.log('Received on [' + topic + '] ' + String(payload));
      return;
    }

    if (pretty.indexOf('\n') !== -1) {
      el.value += ts + ' [' + topic + ']\n' + pretty + '\n\n';
    } else {
      el.value += ts + ' [' + topic + '] ' + pretty + '\n';
    }

    el.scrollTop = el.scrollHeight;

    pubsub.attributeMessageToSubscriptions(topic, nowTs);
  };

  pubsub.attributeMessageToSubscriptions = function (topic, nowTs) {
    var patterns = Object.keys(pubsub.subscriptions);
    var i;
    var matchedAny = false;

    for (i = 0; i < patterns.length; i += 1) {
      var pattern = patterns[i];
      var entry = pubsub.subscriptions[pattern];
      if (!entry) {
        continue;
      }

      if (pubsub.topicMatchesPattern(topic, pattern)) {
        matchedAny = true;
        entry.msgCount = (entry.msgCount || 0) + 1;
        entry.lastReceivedTs = nowTs;
      }
    }

    if (matchedAny) {
      pubsub.renderSubscriptions();
    }
  };

  pubsub.topicMatchesPattern = function (topic, pattern) {
    if (typeof topic !== 'string' || typeof pattern !== 'string') {
      return false;
    }

    var t = topic.split('/');
    var p = pattern.split('/');

    var ti = 0;
    var pi = 0;

    while (pi < p.length) {
      var token = p[pi];

      if (token === '>') {
        return true;
      }

      if (ti >= t.length) {
        return false;
      }

      if (token === '*') {
        ti += 1;
        pi += 1;
        continue;
      }

      if (token !== t[ti]) {
        return false;
      }

      ti += 1;
      pi += 1;
    }

    return ti === t.length;
  };

  pubsub.hasActiveSubscriptionCoverage = function (topic) {
    var patterns = Object.keys(pubsub.subscriptions);
    var i;

    for (i = 0; i < patterns.length; i += 1) {
      var pattern = patterns[i];
      var entry = pubsub.subscriptions[pattern];

      if (!entry || entry.state !== 'active') {
        continue;
      }

      if (pubsub.topicMatchesPattern(topic, pattern)) {
        return true;
      }
    }

    return false;
  };

  pubsub.clearMessages = function () {
    var el = document.getElementById('messages');
    if (el) {
      el.value = '';
    }
  };

  pubsub.log = function (line) {
    var now = new Date();
    var ts =
      '[' +
      ('0' + now.getHours()).slice(-2) + ':' +
      ('0' + now.getMinutes()).slice(-2) + ':' +
      ('0' + now.getSeconds()).slice(-2) +
      '] ';
    var el = document.getElementById('log');
    if (!el) {
      return;
    }
    el.value += ts + line + '\n';
    el.scrollTop = el.scrollHeight;
  };

  pubsub.clearLog = function () {
    var el = document.getElementById('log');
    if (el) {
      el.value = '';
    }
  };

  pubsub.setConnectButtonAppearance = function () {
    var connectBtn = document.getElementById('connectToggle');
    if (!connectBtn) {
      return;
    }

    if (pubsub.state.connecting) {
      connectBtn.disabled = true;
      connectBtn.textContent = 'Connecting...';
      return;
    }

    connectBtn.disabled = false;

    if (pubsub.state.connected) {
      connectBtn.textContent = 'Disconnect';
      connectBtn.className = 'ports-btn btn-danger';
    } else {
      connectBtn.textContent = 'Connect';
      connectBtn.className = 'ports-btn ports-btn-primary';
    }
  };

  pubsub.updateUi = function () {
    var publishBtn = document.getElementById('publish');
    var addSubBtn = document.getElementById('addSub');

    pubsub.setConnectButtonAppearance();

    if (publishBtn) { publishBtn.disabled = false; }
    if (addSubBtn) { addSubBtn.disabled = false; }

    pubsub.updateSubscriptionActionButtons();
  };

  pubsub.updateSubscriptionActionButtons = function () {
    var tbody = document.getElementById('subsTbody');
    if (!tbody) {
      return;
    }

    var buttons = tbody.querySelectorAll('button[data-action]');
    var i;
    for (i = 0; i < buttons.length; i += 1) {
      var btn = buttons[i];
      var action = btn.getAttribute('data-action');
      var pattern = btn.getAttribute('data-pattern');
      var entry = pubsub.subscriptions[pattern];
      var state = entry ? entry.state : '';

      if (action === 'toggle') {
        if (!pubsub.state.connected || state === 'pending_add' || state === 'pending_remove') {
          btn.disabled = true;
        } else {
          btn.disabled = false;
        }
      } else if (action === 'delete') {
        btn.disabled = (state === 'active' || state === 'pending_add' || state === 'pending_remove');
      }
    }
  };

  pubsub.renderSubscriptions = function () {
    var emptyHint = document.getElementById('subsEmptyHint');
    var table = document.getElementById('subsTable');
    var tbody = document.getElementById('subsTbody');

    if (!tbody) {
      return;
    }

    while (tbody.firstChild) {
      tbody.removeChild(tbody.firstChild);
    }

    var patterns = Object.keys(pubsub.subscriptions);
    patterns.sort();

    if (patterns.length === 0) {
      if (emptyHint) { emptyHint.style.display = 'block'; }
      if (table) { table.classList.add('is-hidden'); }
      return;
    }

    if (emptyHint) { emptyHint.style.display = 'none'; }
    if (table) { table.classList.remove('is-hidden'); }

    patterns.forEach(function (pattern) {
      var entry = pubsub.subscriptions[pattern];
      var state = entry ? entry.state : 'unknown';

      var tr = document.createElement('tr');

      var tdPattern = document.createElement('td');
      tdPattern.textContent = pattern;

      var tdStatus = document.createElement('td');
      var statusSpan = document.createElement('span');
      statusSpan.className = 'status-pill';
      statusSpan.textContent = pubsub.statusLabel(state);
      if (state === 'error' && entry && entry.lastError) {
        statusSpan.title = entry.lastError;
      }
      tdStatus.appendChild(statusSpan);

      var tdCount = document.createElement('td');
      tdCount.textContent = String(entry && entry.msgCount ? entry.msgCount : 0);

      var tdLast = document.createElement('td');
      tdLast.textContent = pubsub.formatTime(entry && entry.lastReceivedTs ? entry.lastReceivedTs : 0);

      var tdAction = document.createElement('td');

      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.setAttribute('data-action', 'toggle');
      toggleBtn.setAttribute('data-pattern', pattern);

      if (state === 'active') {
        toggleBtn.className = 'ports-btn btn-danger';
        toggleBtn.textContent = 'Unsubscribe';
      } else if (state === 'pending_add' || state === 'pending_remove') {
        toggleBtn.className = 'ports-btn';
        toggleBtn.textContent = 'Pending...';
        toggleBtn.disabled = true;
      } else {
        toggleBtn.className = 'ports-btn ports-btn-primary';
        toggleBtn.textContent = 'Re-Subscribe';
      }

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ports-btn';
      delBtn.textContent = 'Delete';
      delBtn.setAttribute('data-action', 'delete');
      delBtn.setAttribute('data-pattern', pattern);

      toggleBtn.style.marginRight = '8px';

      tdAction.appendChild(toggleBtn);
      tdAction.appendChild(delBtn);

      tr.appendChild(tdPattern);
      tr.appendChild(tdStatus);
      tr.appendChild(tdCount);
      tr.appendChild(tdLast);
      tr.appendChild(tdAction);

      tbody.appendChild(tr);
    });

    pubsub.updateSubscriptionActionButtons();
  };

  pubsub.validateConnectionFields = function () {
    var hosturl = document.getElementById('hosturl').value;
    var username = document.getElementById('username').value;
    var pass = document.getElementById('password').value;
    var vpn = document.getElementById('message-vpn').value;

    if (!hosturl || !username || !pass || !vpn) {
      pubsub.setStatus('warn', 'Missing connection details', 'Fill in URL, VPN, Username, and Password in Step 1.');
      pubsub.log('Cannot connect: please specify all connection fields.');
      return null;
    }

    return { hosturl: hosturl, username: username, pass: pass, vpn: vpn };
  };

  pubsub.createSession = function (c) {
    pubsub.log('Connecting to broker at ' + c.hosturl);

    try {
      pubsub.session = solace.SolclientFactory.createSession({
        url: c.hosturl,
        vpnName: c.vpn,
        userName: c.username,
        password: c.pass
      });
    } catch (e) {
      pubsub.setStatus('error', 'Session creation failed', 'Check browser console for details. Verify the WebSocket URL format.');
      pubsub.log(e.toString());
      pubsub.session = null;
      return;
    }

    pubsub.session.on(solace.SessionEventCode.UP_NOTICE, function () {
      pubsub.state.connected = true;
      pubsub.state.connecting = false;

      pubsub.setStatus('success', 'Connected', 'Step 3 is ready: add a subscription pattern to start receiving messages.');
      pubsub.clearSubStatus();
      pubsub.clearPubStatus();

      pubsub.closeDetails('step1Card');
      pubsub.openDetails('step3Card');

      pubsub.updateUi();
      pubsub.renderSubscriptions();
    });

    pubsub.session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, function (e) {
      pubsub.state.connected = false;
      pubsub.state.connecting = false;

      pubsub.setStatus('error', 'Connection failed', 'Check URL/VPN/credentials. Then try Connect again.');

      pubsub.log('Connect failed: ' + e.infoStr);
      pubsub.safeDisposeSession();

      pubsub.markSubscriptionsDisconnected();
      pubsub.updateUi();
      pubsub.renderSubscriptions();
    });

    pubsub.session.on(solace.SessionEventCode.DISCONNECTED, function () {
      pubsub.state.connected = false;
      pubsub.state.connecting = false;

      pubsub.setStatus(
        'warn',
        'Disconnected',
        'Reconnect in Step 2. Existing subscription rows are kept, but are not active until you Re-Subscribe.'
      );

      pubsub.log('Disconnected.');
      pubsub.safeDisposeSession();

      pubsub.markSubscriptionsDisconnected();
      pubsub.updateUi();
      pubsub.renderSubscriptions();
    });

    pubsub.session.on(solace.SessionEventCode.SUBSCRIPTION_ERROR, function (e) {
      var pattern = (e && e.correlationKey) ? String(e.correlationKey) : '';
      if (!pattern) {
        pubsub.setSubStatus('error', 'Subscription error', 'A subscription failed. Check the Activity Log for details.');
        pubsub.log('Subscription error (missing correlationKey).');
        return;
      }

      var entry = pubsub.subscriptions[pattern];
      if (!entry) {
        pubsub.setSubStatus('error', 'Subscription error', 'A subscription failed. Check the Activity Log for details.');
        pubsub.log('Subscription error for unknown pattern: ' + pattern);
        return;
      }

      entry.state = 'error';
      entry.lastError = e.infoStr ? String(e.infoStr) : 'Subscription error';

      pubsub.setSubStatus('error', 'Subscription failed', 'Subscription error for "' + pattern + '": ' + entry.lastError);

      pubsub.log('Subscription error for "' + pattern + '": ' + entry.lastError);

      pubsub.updateUi();
      pubsub.renderSubscriptions();
    });

    pubsub.session.on(solace.SessionEventCode.SUBSCRIPTION_OK, function (e) {
      var pattern = (e && e.correlationKey) ? String(e.correlationKey) : '';
      if (!pattern) {
        pubsub.log('Subscription OK (missing correlationKey).');
        return;
      }

      var entry = pubsub.subscriptions[pattern];
      if (!entry) {
        pubsub.log('Subscription OK for unknown pattern: ' + pattern);
        return;
      }

      if (entry.state === 'pending_add') {
        entry.state = 'active';
        delete entry.lastError;
        pubsub.log('Subscribed: ' + pattern);
        pubsub.clearSubStatus();
      } else if (entry.state === 'pending_remove') {
        entry.state = 'inactive';
        delete entry.lastError;
        pubsub.log('Unsubscribed: ' + pattern);
        pubsub.clearSubStatus();
      } else {
        pubsub.log('Subscription confirmation for "' + pattern + '" but local state was "' + entry.state + '".');
      }

      pubsub.updateUi();
      pubsub.renderSubscriptions();
    });

    pubsub.session.on(solace.SessionEventCode.MESSAGE, function (message) {
      var payload = message.getSdtContainer().getValue();
      var topic = message.getDestination().getName();
      pubsub.appendMessage(topic, payload);
    });
  };

  pubsub.markSubscriptionsDisconnected = function () {
    var patterns = Object.keys(pubsub.subscriptions);
    patterns.forEach(function (pattern) {
      var entry = pubsub.subscriptions[pattern];
      if (!entry) {
        return;
      }

      if (entry.state === 'active' || entry.state === 'pending_add' || entry.state === 'pending_remove') {
        entry.state = 'disconnected';
      }
    });
  };

  pubsub.safeDisposeSession = function () {
    if (pubsub.session) {
      try {
        pubsub.session.dispose();
      } catch (e) {
        pubsub.log(e.toString());
      }
      pubsub.session = null;
    }
  };

  pubsub.connectToggle = function () {
    if (pubsub.state.connecting) {
      pubsub.setStatus('info', 'Connecting', 'Please wait…');
      pubsub.log('Connect already in progress.');
      return;
    }

    if (pubsub.state.connected) {
      pubsub.disconnect();
      return;
    }

    var c = pubsub.validateConnectionFields();
    if (!c) {
      return;
    }

    pubsub.state.connecting = true;
    pubsub.setStatus('info', 'Connecting', 'Opening a session to the broker…');

    pubsub.updateUi();
    pubsub.createSession(c);

    if (!pubsub.session) {
      pubsub.state.connecting = false;
      pubsub.setStatus('error', 'Session creation failed', 'Check the broker URL format and try again.');
      pubsub.updateUi();
      return;
    }

    try {
      pubsub.session.connect();
    } catch (e) {
      pubsub.log(e.toString());
      pubsub.state.connecting = false;
      pubsub.safeDisposeSession();

      pubsub.setStatus('error', 'Connect failed', 'Check URL/VPN/credentials. Then try Connect again.');
      pubsub.updateUi();
    }
  };

  pubsub.disconnect = function () {
    if (pubsub.session) {
      try {
        pubsub.setStatus('warn', 'Disconnecting', 'Ending the session…');
        pubsub.session.disconnect();
      } catch (e) {
        pubsub.log(e.toString());
        pubsub.setStatus('error', 'Disconnect failed', 'See Activity Log for details.');
      }
    }
  };

  pubsub.publish = function () {
    pubsub.clearPubStatus();

    if (!pubsub.session || !pubsub.state.connected) {
      pubsub.setPubStatus('warn', 'Cannot publish', 'You must connect to a broker first. Enter connection details in Step 1, then click Connect.');
      pubsub.openDetails('step4Card');
      pubsub.log('Publish blocked: not connected.');
      return;
    }

    var styleEl = document.querySelector('input[name="publishStyle"]:checked');
    var style = styleEl ? styleEl.value : 'basic';

    var topic = '';
    var payload = '';
    if (style === 'advanced') {
      topic = document.getElementById('generatedTopic').value;
      payload = document.getElementById('payloadAdvanced').value;
    } else {
      topic = document.getElementById('pubTopic').value;
      payload = document.getElementById('payload').value;
    }

    topic = (topic || '').trim();

    if (!topic) {
      pubsub.setPubStatus('warn', 'Missing topic', 'Enter a topic in Step 4 before publishing.');
      pubsub.log('Cannot publish: please specify a topic.');
      return;
    }

    var msg = solace.SolclientFactory.createMessage();

    try {
      msg.setDestination(solace.SolclientFactory.createTopicDestination(topic));
    } catch (e1) {
      var detail1 = (e1 && e1.message) ? e1.message : e1.toString();
      pubsub.setPubStatus('error', 'Invalid topic', detail1);
      pubsub.log('Publish failed: ' + detail1);
      return;
    }

    // Delivery mode: if advanced, use advanced delivery radio; otherwise default DIRECT
    try {
      if (style === 'advanced') {
        var advDm = document.querySelector('input[name="advDeliveryMode"]:checked');
        if (advDm && advDm.value === 'PERSISTENT') {
          msg.setDeliveryMode(solace.MessageDeliveryModeType.PERSISTENT);
        } else {
          msg.setDeliveryMode(solace.MessageDeliveryModeType.DIRECT);
        }
      } else {
        msg.setDeliveryMode(solace.MessageDeliveryModeType.DIRECT);
      }
    } catch (e3) {
      var detail3 = (e3 && e3.message) ? e3.message : e3.toString();
      pubsub.setPubStatus('error', 'Invalid publish option', detail3);
      pubsub.log('Publish failed: ' + detail3);
      return;
    }

    msg.setSdtContainer(solace.SDTField.create(solace.SDTFieldType.STRING, payload));

    try {
      pubsub.session.send(msg);
      if (!pubsub.hasActiveSubscriptionCoverage(topic)) {
        pubsub.setPubStatus('info', 'Published', 'Hint: The topic of this published message is not currently covered in your subscription interest.');
      } else {
        pubsub.clearPubStatus();
      }
      pubsub.log('Published message to: ' + topic);
    } catch (e2) {
      var detail2 = (e2 && e2.message) ? e2.message : e2.toString();
      pubsub.setPubStatus('error', 'Publish failed', 'Check that you are still connected, then try again.');
      pubsub.log('Publish failed: ' + detail2);
    }
  };

  pubsub.subscribePattern = function (pattern, isResubscribe) {
    pubsub.clearSubStatus();

    if (!pubsub.session || !pubsub.state.connected) {
      pubsub.setSubStatus('warn', 'Not connected', 'Connect before subscribing.');
      pubsub.log('Cannot subscribe: not connected.');
      return;
    }

    if (!pattern) {
      pubsub.setSubStatus('warn', 'Invalid pattern', 'Enter a subscription pattern (for example: workshop/*).');
      pubsub.log('Cannot subscribe: invalid pattern.');
      return;
    }

    var entry = pubsub.subscriptions[pattern];
    if (!entry) {
      pubsub.subscriptions[pattern] = { state: 'pending_add', msgCount: 0, lastReceivedTs: 0 };
    } else {
      if (entry.state === 'active' || entry.state === 'pending_add' || entry.state === 'pending_remove') {
        pubsub.setSubStatus('warn', 'Duplicate subscription', 'That pattern is already subscribed (or still updating).');
        pubsub.log('Already subscribed or pending for "' + pattern + '". (Duplicates are not allowed.)');
        return;
      }
      entry.state = 'pending_add';
      delete entry.lastError;
      entry.msgCount = entry.msgCount || 0;
      entry.lastReceivedTs = entry.lastReceivedTs || 0;
    }

    pubsub.renderSubscriptions();
    pubsub.updateUi();

    pubsub.log((isResubscribe ? 'Re-subscribing: ' : 'Subscribing: ') + pattern);

    try {
      pubsub.session.subscribe(
        solace.SolclientFactory.createTopicDestination(pattern),
        true,
        pattern,
        10000
      );
    } catch (e) {
      var detail = (e && e.message) ? e.message : e.toString();
      pubsub.setSubStatus('error', 'Subscribe failed', 'Check the pattern for typos, then try again.');
      pubsub.log('Subscribe failed: ' + detail);

      pubsub.subscriptions[pattern].state = 'error';
      pubsub.subscriptions[pattern].lastError = detail;
      pubsub.renderSubscriptions();
      pubsub.updateUi();
    }
  };

  pubsub.addSubscriptionFromInput = function () {
    pubsub.clearSubStatus();

    var raw = document.getElementById('subTopic').value;
    var pattern = pubsub.normalizePattern(raw);

    if (!pattern) {
      pubsub.setSubStatus('warn', 'Missing pattern', 'Enter a subscription pattern (for example: workshop/*).');
      pubsub.log('Cannot subscribe: please enter a subscription pattern.');
      return;
    }

    var existing = pubsub.subscriptions[pattern];
    var willAttempt = false;

    if (!existing) {
      willAttempt = true;
    } else if (existing.state === 'inactive' || existing.state === 'error' || existing.state === 'disconnected') {
      willAttempt = true;
    } else {
      willAttempt = false;
    }

    if (!pubsub.uiFlags.firstSubExpansionsDone && pubsub.state.connected && willAttempt) {
      pubsub.closeDetails('step2Card');
      pubsub.openDetails('step4Card');
      pubsub.openDetails('receivedCard');
      pubsub.uiFlags.firstSubExpansionsDone = true;
    }

    var isResubscribe = !!(existing && (existing.state === 'inactive' || existing.state === 'error' || existing.state === 'disconnected'));
    pubsub.subscribePattern(pattern, isResubscribe);
  };

  pubsub.unsubscribePattern = function (pattern) {
    pubsub.clearSubStatus();

    if (!pubsub.session || !pubsub.state.connected) {
      pubsub.setSubStatus('warn', 'Not connected', 'Connect before unsubscribing.');
      pubsub.log('Cannot unsubscribe: not connected.');
      return;
    }

    pattern = pubsub.normalizePattern(pattern);
    if (!pattern) {
      pubsub.setSubStatus('warn', 'Invalid pattern', 'That subscription pattern is not valid.');
      pubsub.log('Cannot unsubscribe: invalid pattern.');
      return;
    }

    var entry = pubsub.subscriptions[pattern];
    if (!entry) {
      pubsub.setSubStatus('warn', 'Unknown subscription', 'That subscription row was not found.');
      pubsub.log('Cannot unsubscribe: no subscription entry for "' + pattern + '".');
      return;
    }

    if (entry.state !== 'active') {
      pubsub.setSubStatus('warn', 'Not subscribed', 'That row is not currently subscribed.');
      pubsub.log('Cannot unsubscribe "' + pattern + '" because it is not currently subscribed.');
      return;
    }

    entry.state = 'pending_remove';
    pubsub.renderSubscriptions();
    pubsub.updateUi();

    pubsub.log('Unsubscribing: ' + pattern);
    try {
      pubsub.session.unsubscribe(
        solace.SolclientFactory.createTopicDestination(pattern),
        true,
        pattern,
        10000
      );
    } catch (e) {
      var detail = (e && e.message) ? e.message : e.toString();
      pubsub.setSubStatus('error', 'Unsubscribe failed', 'See Activity Log for details.');
      pubsub.log('Unsubscribe failed: ' + detail);

      entry.state = 'error';
      entry.lastError = detail;
      pubsub.renderSubscriptions();
      pubsub.updateUi();
    }
  };

  pubsub.toggleSubscription = function (pattern) {
    pubsub.clearSubStatus();

    pattern = pubsub.normalizePattern(pattern);
    if (!pattern) {
      pubsub.setSubStatus('warn', 'Invalid pattern', 'That subscription pattern is not valid.');
      pubsub.log('Cannot toggle: invalid pattern.');
      return;
    }

    var entry = pubsub.subscriptions[pattern];
    if (!entry) {
      pubsub.setSubStatus('warn', 'Unknown subscription', 'That subscription row was not found.');
      pubsub.log('Cannot toggle: no subscription entry for "' + pattern + '".');
      return;
    }

    if (entry.state === 'pending_add' || entry.state === 'pending_remove') {
      pubsub.setSubStatus('info', 'Please wait', 'That subscription is currently updating.');
      pubsub.log('Please wait: "' + pattern + '" is currently updating.');
      return;
    }

    if (entry.state === 'active') {
      pubsub.unsubscribePattern(pattern);
    } else if (entry.state === 'inactive' || entry.state === 'error' || entry.state === 'disconnected') {
      pubsub.subscribePattern(pattern, true);
    } else {
      pubsub.setSubStatus('warn', 'Cannot toggle', 'That row is in an unknown state.');
      pubsub.log('Cannot toggle "' + pattern + '" because state is "' + entry.state + '".');
    }
  };

  pubsub.deleteSubscription = function (pattern) {
    pubsub.clearSubStatus();

    pattern = pubsub.normalizePattern(pattern);
    if (!pattern) {
      pubsub.setSubStatus('warn', 'Invalid pattern', 'That subscription pattern is not valid.');
      pubsub.log('Cannot delete: invalid pattern.');
      return;
    }

    var entry = pubsub.subscriptions[pattern];
    if (!entry) {
      pubsub.setSubStatus('warn', 'Unknown subscription', 'That subscription row was not found.');
      pubsub.log('Cannot delete: no subscription entry for "' + pattern + '".');
      return;
    }

    if (entry.state === 'active' || entry.state === 'pending_add' || entry.state === 'pending_remove') {
      pubsub.setSubStatus('warn', 'Cannot delete yet', 'Unsubscribe first, then Delete.');
      pubsub.log('Cannot delete "' + pattern + '" while it is subscribed or updating. Unsubscribe first.');
      return;
    }

    delete pubsub.subscriptions[pattern];
    pubsub.log('Deleted subscription entry: ' + pattern);

    pubsub.renderSubscriptions();
    pubsub.updateUi();
  };

  window.PubSubApp = {
    init: pubsub.init
  };

}());

const { InvalidMailboxQuery, parseMailboxQuery } = require('./mailbox-query');
const { GraphError } = require('./graph');

/** Dependencies are injectable so auth and Graph failures can be checked offline. */
function createSearchHandler({ isConfigured, tokenFor, searchInbox }) {
  return async (req, res) => {
    if (!isConfigured()) {
      return res.status(503).json({
        code: 'OUTLOOK_NOT_CONFIGURED',
        error: 'Outlook is not connected. Ask your administrator to configure Microsoft sign-in for this application.',
      });
    }
    try {
      const token = await tokenFor(req);
      if (!token) return res.status(401).json({ code: 'OUTLOOK_SIGN_IN_REQUIRED', error: 'Sign in to Outlook to search your inbox. If your session expired, reconnect Outlook.' });
      // Validate before making any mailbox request. searchInbox also validates for direct callers.
      parseMailboxQuery(req.body?.prompt);
      return res.json(await searchInbox(token, req.body.prompt));
    } catch (error) {
      if (error instanceof InvalidMailboxQuery) return res.status(400).json({ code: 'INVALID_MAILBOX_QUERY', error: error.message });
      if (error instanceof GraphError && error.status === 401) {
        return res.status(401).json({ code: 'OUTLOOK_SIGN_IN_REQUIRED', error: 'Your Outlook connection expired. Reconnect Outlook and try again.' });
      }
      if (error instanceof GraphError && error.status === 403) {
        return res.status(403).json({ code: 'MAILBOX_ACCESS_DENIED', error: 'Outlook denied mailbox access. Ask your administrator to grant the application delegated Mail.Read permission, then reconnect Outlook.' });
      }
      if (error instanceof GraphError && error.status === 429) {
        return res.status(429).json({ code: 'MAILBOX_UNAVAILABLE', error: 'Outlook is limiting requests. Wait a moment, then search again.' });
      }
      return res.status(502).json({ code: 'MAILBOX_UNAVAILABLE', error: 'Outlook search could not complete. Check the connection and try again.' });
    }
  };
}

module.exports = { createSearchHandler };

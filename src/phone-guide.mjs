// Phone control (1.6.0), stage P6: the setup guide, shown in Engine settings behind More and copied into the release
// notes. Each step was checked against Discord's documentation on 2026-11-26 (artifacts/reviews/2026-11-25-phone-control/
// p6-note.md marks each verified or inferred); the app's own steps are the app's.
export const PHONE_GUIDE=[
  'In the Discord Developer Portal (discord.com/developers/applications), choose Create App, give it a name and press Create.',
  'On General Information, copy the Application ID: it is discordApplicationId.',
  'On Bot, press Reset Token and copy the token: it is shown once. It is discordBotToken. Turn off Public Bot so only you can add the bot. No privileged intents are needed.',
  'In the Discord app, make a private server for this: Add a Server, Create My Own, For me and my friends. Invite no one.',
  'Add the bot to that server with this link, your Application ID in place of APP_ID: https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=0 . It asks for no permissions.',
  'Turn on Developer Mode (User Settings, Advanced). Then copy the server\'s id (discordServerId), the channel\'s id (discordChannelId) and your own user id (discordUserId) from their menus (right-click, or a long press on the phone).',
  'Put the five keys in your provider file beside your AI keys, then reconnect the file in Connections.',
  'Set the PIN here, then turn on Phone control and save.',
  'First test with the Korean and U.S. markets closed: send /status, then /stop, then /start (it shows what would start; press Confirm with PIN and enter the PIN).',
  'If the bot token leaks: press Reset Token in the Developer Portal, put the new token in the provider file, reconnect it, and set a new PIN here.'];
export const PHONE_CONFIRM={title:'Turn on phone control?',
  body:'Use Discord on your phone for Status, Stop, Stop everything, Start, and fixing orders whose KIS reply was lost. It cannot place, change or cancel orders, or change settings.',
  more:['Start and the lost-order fixes need your PIN. Status and the two Stops do not.',
    'Replies can show stock codes, and /orders shows order quantities and prices. Account amounts follow Show amounts.',
    'Needs the PIN set below and the five Discord keys in your provider file (see the setup guide).',
    'Only your user, in your server and channel, through your bot, is answered.',
    'If phone control or Discord fails, trading goes on as set on this PC. Turning this off disconnects at once.']};

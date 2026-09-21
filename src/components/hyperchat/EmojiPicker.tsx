'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Search, Smile, Film, X, Bookmark, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sounds } from '@/lib/client/sounds'
import { apiClient } from '@/lib/client/api'
import { useChatStore } from '@/lib/client/store'
import { EmojiText, isServerEmojiName, lookupServerEmoji, getServerEmojiVersion } from '@/lib/client/serverEmoji'
import { hasPerm, PERM } from '@/lib/perm'
import type { StickerSummary } from '@/lib/types'

type EmojiDef = { char: string; names: string }

/** GIF payload handed to the composer; sent as message imageUrl. */
type GifPick = { url: string; title: string }

/** Shape returned by GET /api/gifs. */
type GifResult = { id: string; url: string; title: string; preview?: string }

/** Stable empty list for store-selector fallbacks: a fresh [] there breaks
 *  getSnapshot caching and loops React. */
const EMPTY_EMOJI_LIST: { id: string; name: string; url: string }[] = []
/** Same stability trick for the sticker grid. */
const EMPTY_STICKER_LIST: StickerSummary[] = []

// Compact but broad emoji kit: 8 categories, searchable by keyword names.
const CATEGORIES: { id: string; label: string; emojis: EmojiDef[] }[] = [
  {
    id: 'smileys',
    label: 'smileys',
    emojis: [
      { char: '😀', names: 'grinning happy smile' },
      { char: '😃', names: 'smiley happy smile' },
      { char: '😄', names: 'smile laugh happy' },
      { char: '😁', names: 'grin beam' },
      { char: '😆', names: 'laughing lol squint' },
      { char: '😅', names: 'sweat smile nervous' },
      { char: '🤣', names: 'rofl dying laugh' },
      { char: '😂', names: 'joy tears crying laugh' },
      { char: '🙂', names: 'slight smile' },
      { char: '🙃', names: 'upside down silly' },
      { char: '😉', names: 'wink' },
      { char: '😊', names: 'blush happy' },
      { char: '😇', names: 'angel halo innocent' },
      { char: '🥰', names: 'love hearts adore' },
      { char: '😍', names: 'heart eyes love' },
      { char: '🤩', names: 'star struck wow' },
      { char: '😘', names: 'kiss' },
      { char: '😗', names: 'kissing' },
      { char: '😚', names: 'kiss closed eyes' },
      { char: '😋', names: 'yum tasty' },
      { char: '😛', names: 'tongue' },
      { char: '😜', names: 'wink tongue crazy' },
      { char: '🤪', names: 'zany crazy silly' },
      { char: '🤨', names: 'raised eyebrow suspicious' },
      { char: '🧐', names: 'monocle inspect' },
      { char: '🤓', names: 'nerd glasses smart' },
      { char: '😎', names: 'cool sunglasses' },
      { char: '🥳', names: 'party celebrate' },
      { char: '😏', names: 'smirk' },
      { char: '😒', names: 'unamused meh' },
      { char: '😞', names: 'sad disappointed' },
      { char: '😔', names: 'pensive sad' },
      { char: '😟', names: 'worried' },
      { char: '😕', names: 'confused' },
      { char: '🙁', names: 'frown sad' },
      { char: '😣', names: 'persevere' },
      { char: '😖', names: 'confounded' },
      { char: '😫', names: 'tired' },
      { char: '😩', names: 'weary exhausted' },
      { char: '🥺', names: 'pleading puppy eyes' },
      { char: '😢', names: 'cry sad tear' },
      { char: '😭', names: 'sob crying loudly' },
      { char: '😤', names: 'triumph huff angry' },
      { char: '😠', names: 'angry mad' },
      { char: '😡', names: 'rage red angry' },
      { char: '🤬', names: 'swear cursing' },
      { char: '🤯', names: 'mind blown exploding head' },
      { char: '😳', names: 'flushed embarrassed' },
      { char: '🥵', names: 'hot heat' },
      { char: '🥶', names: 'cold freezing' },
      { char: '😱', names: 'scream fear' },
      { char: '😨', names: 'fearful scared' },
      { char: '😰', names: 'anxious nervous' },
      { char: '🤗', names: 'hug' },
      { char: '🤔', names: 'thinking hmm' },
      { char: '🤭', names: 'giggle hand mouth' },
      { char: '🤫', names: 'shush quiet secret' },
      { char: '🤥', names: 'lying pinocchio' },
      { char: '😶', names: 'silent no mouth' },
      { char: '😐', names: 'neutral face' },
      { char: '😑', names: 'expressionless' },
      { char: '🙄', names: 'eye roll whatever' },
      { char: '😴', names: 'sleep tired zz' },
      { char: '🤤', names: 'drool' },
      { char: '😵', names: 'dizzy dead' },
      { char: '🤐', names: 'zipper mouth shut' },
      { char: '🥴', names: 'woozy dizzy' },
      { char: '🤢', names: 'nauseated sick green' },
      { char: '🤮', names: 'vomit puke sick' },
      { char: '🤧', names: 'sneeze' },
      { char: '😷', names: 'mask sick' },
      { char: '🤒', names: 'thermometer fever' },
      { char: '🤕', names: 'bandage hurt injured' },
      { char: '🤑', names: 'money mouth greedy' },
      { char: '🤠', names: 'cowboy hat' },
      { char: '🥸', names: 'disguise fake mustache' },
      { char: '😈', names: 'devil smirk evil' },
      { char: '👿', names: 'imp devil angry' },
      { char: '💀', names: 'skull dead' },
      { char: '👻', names: 'ghost spooky' },
      { char: '👽', names: 'alien ufo' },
      { char: '🤖', names: 'robot bot' },
      { char: '💩', names: 'poop' },
      { char: '🎭', names: 'theater masks drama' },
    ],
  },
  {
    id: 'gestures',
    label: 'people',
    emojis: [
      { char: '👋', names: 'wave hello hi bye' },
      { char: '🤚', names: 'raised back hand' },
      { char: '✋', names: 'hand stop high five' },
      { char: '🖖', names: 'spock vulcan' },
      { char: '👌', names: 'ok perfect' },
      { char: '🤌', names: 'pinched fingers italian' },
      { char: '✌️', names: 'peace victory two' },
      { char: '🤞', names: 'fingers crossed luck hope' },
      { char: '🤟', names: 'love you sign' },
      { char: '🤘', names: 'rock horns metal' },
      { char: '🤙', names: 'call me shaka' },
      { char: '👈', names: 'point left' },
      { char: '👉', names: 'point right' },
      { char: '👆', names: 'point up' },
      { char: '👇', names: 'point down' },
      { char: '☝️', names: 'index point up notice' },
      { char: '👍', names: 'thumbs up like yes approve' },
      { char: '👎', names: 'thumbs down dislike no' },
      { char: '✊', names: 'fist bump' },
      { char: '👊', names: 'punch fist bump' },
      { char: '🤛', names: 'left fist bump' },
      { char: '🤜', names: 'right fist bump' },
      { char: '👏', names: 'clap applause bravo' },
      { char: '🙌', names: 'raised hands celebrate hooray' },
      { char: '👐', names: 'open hands' },
      { char: '🤲', names: 'palms up' },
      { char: '🤝', names: 'handshake deal agreement' },
      { char: '🙏', names: 'pray please thanks hope' },
      { char: '✍️', names: 'write writing' },
      { char: '💅', names: 'nails manicure' },
      { char: '🤳', names: 'selfie' },
      { char: '💪', names: 'muscle strong flex' },
      { char: '🦾', names: 'mechanical arm robot' },
      { char: '🧠', names: 'brain smart' },
      { char: '👀', names: 'eyes look watching' },
      { char: '👁️', names: 'eye watching' },
      { char: '👅', names: 'tongue taste' },
      { char: '👄', names: 'lips mouth kiss' },
      { char: '🫡', names: 'salute yes sir' },
      { char: '🫠', names: 'melting face' },
    ],
  },
  {
    id: 'hearts',
    label: 'hearts',
    emojis: [
      { char: '❤️', names: 'red heart love' },
      { char: '🧡', names: 'orange heart' },
      { char: '💛', names: 'yellow heart' },
      { char: '💚', names: 'green heart' },
      { char: '💙', names: 'blue heart' },
      { char: '💜', names: 'purple heart' },
      { char: '🖤', names: 'black heart' },
      { char: '🤍', names: 'white heart' },
      { char: '🤎', names: 'brown heart' },
      { char: '💔', names: 'broken heart sad' },
      { char: '❣️', names: 'heart exclamation' },
      { char: '💕', names: 'two hearts love' },
      { char: '💞', names: 'revolving hearts' },
      { char: '💓', names: 'beating heart pulse' },
      { char: '💗', names: 'growing heart' },
      { char: '💖', names: 'sparkling heart' },
      { char: '💘', names: 'heart arrow cupid' },
      { char: '💝', names: 'heart gift ribbon' },
      { char: '💟', names: 'heart decoration' },
      { char: '♥️', names: 'heart suit' },
      { char: '🫶', names: 'heart hands' },
    ],
  },
  {
    id: 'animals',
    label: 'animals',
    emojis: [
      { char: '🐶', names: 'dog puppy' },
      { char: '🐱', names: 'cat kitten meow' },
      { char: '🐭', names: 'mouse' },
      { char: '🐹', names: 'hamster' },
      { char: '🐰', names: 'rabbit bunny' },
      { char: '🦊', names: 'fox' },
      { char: '🐻', names: 'bear' },
      { char: '🐼', names: 'panda' },
      { char: '🐨', names: 'koala' },
      { char: '🐯', names: 'tiger' },
      { char: '🦁', names: 'lion' },
      { char: '🐮', names: 'cow moo' },
      { char: '🐷', names: 'pig oink' },
      { char: '🐸', names: 'frog' },
      { char: '🐵', names: 'monkey' },
      { char: '🦄', names: 'unicorn' },
      { char: '🐝', names: 'bee buzz' },
      { char: '🦋', names: 'butterfly' },
      { char: '🐌', names: 'snail' },
      { char: '🐙', names: 'octopus' },
      { char: '🦑', names: 'squid' },
      { char: '🦀', names: 'crab' },
      { char: '🐠', names: 'tropical fish' },
      { char: '🐟', names: 'fish' },
      { char: '🐬', names: 'dolphin' },
      { char: '🐳', names: 'whale' },
      { char: '🦈', names: 'shark' },
      { char: '🐊', names: 'crocodile' },
      { char: '🦕', names: 'dinosaur dino' },
      { char: '🐍', names: 'snake' },
      { char: '🐲', names: 'dragon' },
      { char: '🦅', names: 'eagle' },
      { char: '🦉', names: 'owl' },
      { char: '🦇', names: 'bat' },
      { char: '🐺', names: 'wolf' },
      { char: '🐴', names: 'horse' },
      { char: '🦄', names: 'unicorn magic' },
      { char: '🐝', names: 'bee' },
      { char: '🕷️', names: 'spider' },
      { char: '🐢', names: 'turtle slow' },
    ],
  },
  {
    id: 'food',
    label: 'food',
    emojis: [
      { char: '🍏', names: 'green apple' },
      { char: '🍎', names: 'red apple' },
      { char: '🍊', names: 'orange tangerine' },
      { char: '🍋', names: 'lemon' },
      { char: '🍌', names: 'banana' },
      { char: '🍉', names: 'watermelon' },
      { char: '🍇', names: 'grapes' },
      { char: '🍓', names: 'strawberry berry' },
      { char: '🍒', names: 'cherries' },
      { char: '🍑', names: 'peach' },
      { char: '🍍', names: 'pineapple' },
      { char: '🥝', names: 'kiwi' },
      { char: '🍅', names: 'tomato' },
      { char: '🥑', names: 'avocado' },
      { char: '🍔', names: 'burger hamburger' },
      { char: '🍟', names: 'fries chips' },
      { char: '🍕', names: 'pizza' },
      { char: '🌭', names: 'hotdog' },
      { char: '🥪', names: 'sandwich' },
      { char: '🌮', names: 'taco' },
      { char: '🌯', names: 'burrito' },
      { char: '🍜', names: 'noodles ramen' },
      { char: '🍝', names: 'spaghetti pasta' },
      { char: '🍣', names: 'sushi' },
      { char: '🍤', names: 'shrimp tempura' },
      { char: '🍚', names: 'rice' },
      { char: '🍦', names: 'ice cream soft serve' },
      { char: '🍩', names: 'donut doughnut' },
      { char: '🍪', names: 'cookie' },
      { char: '🎂', names: 'birthday cake' },
      { char: '🍰', names: 'cake slice' },
      { char: '🧁', names: 'cupcake' },
      { char: '🥧', names: 'pie' },
      { char: '🍫', names: 'chocolate' },
      { char: '🍬', names: 'candy sweet' },
      { char: '🍭', names: 'lollipop' },
      { char: '☕', names: 'coffee tea hot' },
      { char: '🍵', names: 'green tea' },
      { char: '🧊', names: 'ice cube cold' },
      { char: '🥤', names: 'soda cup drink' },
    ],
  },
  {
    id: 'activities',
    label: 'activity',
    emojis: [
      { char: '⚽', names: 'soccer football' },
      { char: '🏀', names: 'basketball hoops' },
      { char: '🏈', names: 'american football' },
      { char: '⚾', names: 'baseball' },
      { char: '🎾', names: 'tennis' },
      { char: '🏐', names: 'volleyball' },
      { char: '🎱', names: 'pool billiards eight ball' },
      { char: '🏓', names: 'ping pong table tennis' },
      { char: '🎮', names: 'game controller video game' },
      { char: '🕹️', names: 'joystick arcade' },
      { char: '🎲', names: 'dice roll random' },
      { char: '🎯', names: 'dart target bullseye' },
      { char: '🏆', names: 'trophy win champion' },
      { char: '🥇', names: 'gold medal first' },
      { char: '🥈', names: 'silver medal second' },
      { char: '🥉', names: 'bronze medal third' },
      { char: '🎧', names: 'headphones music' },
      { char: '🎤', names: 'microphone sing karaoke' },
      { char: '🎵', names: 'music note' },
      { char: '🎹', names: 'piano keyboard music' },
      { char: '🥁', names: 'drum' },
      { char: '🎸', names: 'guitar rock' },
      { char: '🎺', names: 'trumpet' },
      { char: '🎻', names: 'violin' },
      { char: '🎬', names: 'clapper movie film' },
      { char: '🎨', names: 'art palette paint' },
      { char: '🎭', names: 'theater drama masks' },
      { char: '🎪', names: 'circus tent' },
      { char: '🚀', names: 'rocket launch ship' },
      { char: '🛸', names: 'ufo flying saucer' },
      { char: '🔥', names: 'fire lit hot' },
      { char: '⚡', names: 'lightning zap bolt' },
      { char: '⭐', names: 'star' },
      { char: '🌟', names: 'glowing star' },
      { char: '✨', names: 'sparkles shine magic' },
      { char: '💫', names: 'dizzy star' },
      { char: '🎉', names: 'party popper celebrate tada' },
      { char: '🎊', names: 'confetti ball celebrate' },
      { char: '🎈', names: 'balloon party' },
      { char: '🎁', names: 'gift present' },
    ],
  },
  {
    id: 'objects',
    label: 'objects',
    emojis: [
      { char: '💻', names: 'laptop computer code' },
      { char: '🖥️', names: 'desktop computer' },
      { char: '⌨️', names: 'keyboard' },
      { char: '🖱️', names: 'mouse computer' },
      { char: '📱', names: 'phone mobile' },
      { char: '☎️', names: 'telephone call' },
      { char: '🔋', names: 'battery charge' },
      { char: '💡', names: 'light bulb idea' },
      { char: '🔦', names: 'flashlight' },
      { char: '🕯️', names: 'candle' },
      { char: '🧨', names: 'dynamite explosive' },
      { char: '💰', names: 'money bag cash' },
      { char: '💵', names: 'dollar bill money' },
      { char: '💎', names: 'gem diamond' },
      { char: '⚖️', names: 'balance scales justice' },
      { char: '🔧', names: 'wrench tool fix' },
      { char: '🔨', names: 'hammer build' },
      { char: '⚙️', names: 'gear settings' },
      { char: '🧲', names: 'magnet' },
      { char: '🔒', names: 'locked lock secure' },
      { char: '🔓', names: 'unlocked open' },
      { char: '🔑', names: 'key' },
      { char: '🔨', names: 'hammer' },
      { char: '📌', names: 'pin pinned pushpin' },
      { char: '📎', names: 'paperclip attachment' },
      { char: '✂️', names: 'scissors cut' },
      { char: '📚', names: 'books library' },
      { char: '📖', names: 'book open reading' },
      { char: '📝', names: 'memo note write' },
      { char: '✏️', names: 'pencil' },
      { char: '🔍', names: 'search magnify find' },
      { char: '📅', names: 'calendar date' },
      { char: '⏰', names: 'alarm clock time' },
      { char: '⏳', names: 'hourglass waiting time' },
      { char: '📸', names: 'camera photo' },
      { char: '🎥', names: 'video camera record' },
      { char: '📞', names: 'phone receiver call' },
      { char: '📮', names: 'mailbox post' },
      { char: '🛒', names: 'shopping cart' },
      { char: '🧭', names: 'compass navigate' },
    ],
  },
  {
    id: 'symbols',
    label: 'symbols',
    emojis: [
      { char: '✅', names: 'check yes done correct' },
      { char: '❌', names: 'cross no wrong x' },
      { char: '❓', names: 'question confused' },
      { char: '❗', names: 'exclamation important' },
      { char: '💯', names: 'hundred perfect score' },
      { char: '⚠️', names: 'warning caution' },
      { char: '🚫', names: 'prohibited blocked no' },
      { char: '♻️', names: 'recycle' },
      { char: '🔴', names: 'red circle' },
      { char: '🟠', names: 'orange circle' },
      { char: '🟡', names: 'yellow circle' },
      { char: '🟢', names: 'green circle' },
      { char: '🔵', names: 'blue circle' },
      { char: '⚫', names: 'black circle' },
      { char: '⚪', names: 'white circle' },
      { char: '🔺', names: 'red triangle up' },
      { char: '🔻', names: 'red triangle down' },
      { char: '💤', names: 'sleep zz' },
      { char: '🌀', names: 'cyclone swirl' },
      { char: '♾️', names: 'infinity forever' },
      { char: '🔒', names: 'lock' },
      { char: '🔔', names: 'bell notification' },
      { char: '🔕', names: 'bell muted off' },
      { char: '🎵', names: 'note' },
      { char: '➕', names: 'plus add' },
      { char: '➖', names: 'minus subtract' },
      { char: '➗', names: 'divide' },
      { char: '✖️', names: 'multiply x' },
      { char: '🟰', names: 'equals' },
      { char: '🆗', names: 'ok button' },
      { char: '🆒', names: 'cool button' },
      { char: '🆕', names: 'new button' },
      { char: '🔝', names: 'top button' },
      { char: '⚠️', names: 'warning' },
      { char: '🕐', names: 'clock time' },
    ],
  },
]

/** ISO-3166 code -> country/territory display name + search keywords for
 *  every bundled twemoji flag glyph (258 pairs). The emoji char itself is
 *  derived from the code: A=0x1F1E6, so "US" -> U+1F1FA U+1F1F8. */
const FLAG_NAMES: [string, string][] = [
  ['AC', 'ascension island'],
  ['AD', 'andorra'],
  ['AE', 'united arab emirates flag uae'],
  ['AF', 'afghanistan'],
  ['AG', 'antigua and barbuda'],
  ['AI', 'anguilla'],
  ['AL', 'albania'],
  ['AM', 'armenia'],
  ['AO', 'angola'],
  ['AQ', 'antarctica'],
  ['AR', 'argentina'],
  ['AS', 'american samoa'],
  ['AT', 'austria'],
  ['AU', 'australia'],
  ['AW', 'aruba'],
  ['AX', 'aland islands'],
  ['AZ', 'azerbaijan'],
  ['BA', 'bosnia and herzegovina'],
  ['BB', 'barbados'],
  ['BD', 'bangladesh'],
  ['BE', 'belgium'],
  ['BF', 'burkina faso'],
  ['BG', 'bulgaria'],
  ['BH', 'bahrain'],
  ['BI', 'burundi'],
  ['BJ', 'benin'],
  ['BL', 'st barthelemy'],
  ['BM', 'bermuda'],
  ['BN', 'brunei'],
  ['BO', 'bolivia'],
  ['BQ', 'caribbean netherlands'],
  ['BR', 'brazil'],
  ['BS', 'bahamas'],
  ['BT', 'bhutan'],
  ['BV', 'bouvet island'],
  ['BW', 'botswana'],
  ['BY', 'belarus'],
  ['BZ', 'belize'],
  ['CA', 'canada'],
  ['CC', 'cocos islands'],
  ['CD', 'congo kinshasa flag drc'],
  ['CF', 'central african republic'],
  ['CG', 'congo brazzaville flag congo'],
  ['CH', 'switzerland'],
  ['CI', 'cote divoire'],
  ['CK', 'cook islands'],
  ['CL', 'chile'],
  ['CM', 'cameroon'],
  ['CN', 'china'],
  ['CO', 'colombia'],
  ['CP', 'clipperton island'],
  ['CR', 'costa rica'],
  ['CU', 'cuba'],
  ['CV', 'cape verde'],
  ['CW', 'curacao'],
  ['CX', 'christmas island'],
  ['CY', 'cyprus'],
  ['CZ', 'czechia'],
  ['DE', 'germany'],
  ['DG', 'diego garcia'],
  ['DJ', 'djibouti'],
  ['DK', 'denmark'],
  ['DM', 'dominica'],
  ['DO', 'dominican republic flag dom rep'],
  ['DZ', 'algeria'],
  ['EA', 'ceuta melilla'],
  ['EC', 'ecuador'],
  ['EE', 'estonia'],
  ['EG', 'egypt'],
  ['EH', 'western sahara'],
  ['ER', 'eritrea'],
  ['ES', 'spain'],
  ['ET', 'ethiopia'],
  ['EU', 'european union'],
  ['FI', 'finland'],
  ['FJ', 'fiji'],
  ['FK', 'falkland islands'],
  ['FM', 'micronesia'],
  ['FO', 'faroe islands'],
  ['FR', 'france'],
  ['GA', 'gabon'],
  ['GB', 'united kingdom britain uk england flag uk britain'],
  ['GD', 'grenada'],
  ['GE', 'georgia'],
  ['GF', 'french guiana'],
  ['GG', 'guernsey'],
  ['GH', 'ghana'],
  ['GI', 'gibraltar'],
  ['GL', 'greenland'],
  ['GM', 'gambia'],
  ['GN', 'guinea'],
  ['GP', 'guadeloupe'],
  ['GQ', 'equatorial guinea'],
  ['GR', 'greece'],
  ['GS', 'south georgia'],
  ['GT', 'guatemala'],
  ['GU', 'guam'],
  ['GW', 'guinea bissau'],
  ['GY', 'guyana'],
  ['HK', 'hong kong'],
  ['HM', 'heard island'],
  ['HN', 'honduras'],
  ['HR', 'croatia'],
  ['HT', 'haiti'],
  ['HU', 'hungary'],
  ['IC', 'canary islands'],
  ['ID', 'indonesia'],
  ['IE', 'ireland'],
  ['IL', 'israel'],
  ['IM', 'isle of man'],
  ['IN', 'india'],
  ['IO', 'british indian ocean territory'],
  ['IQ', 'iraq'],
  ['IR', 'iran'],
  ['IS', 'iceland'],
  ['IT', 'italy'],
  ['JE', 'jersey'],
  ['JM', 'jamaica'],
  ['JO', 'jordan'],
  ['JP', 'japan'],
  ['KE', 'kenya'],
  ['KG', 'kyrgyzstan'],
  ['KH', 'cambodia'],
  ['KI', 'kiribati'],
  ['KM', 'comoros'],
  ['KN', 'st kitts and nevis'],
  ['KP', 'north korea flag dprk'],
  ['KR', 'south korea flag korea'],
  ['KW', 'kuwait'],
  ['KY', 'cayman islands'],
  ['KZ', 'kazakhstan'],
  ['LA', 'laos'],
  ['LB', 'lebanon'],
  ['LC', 'st lucia'],
  ['LI', 'liechtenstein'],
  ['LK', 'sri lanka'],
  ['LR', 'liberia'],
  ['LS', 'lesotho'],
  ['LT', 'lithuania'],
  ['LU', 'luxembourg'],
  ['LV', 'latvia'],
  ['LY', 'libya'],
  ['MA', 'morocco'],
  ['MC', 'monaco'],
  ['MD', 'moldova'],
  ['ME', 'montenegro'],
  ['MF', 'st martin'],
  ['MG', 'madagascar'],
  ['MH', 'marshall islands'],
  ['MK', 'north macedonia'],
  ['ML', 'mali'],
  ['MM', 'myanmar burma flag burma'],
  ['MN', 'mongolia'],
  ['MO', 'macau'],
  ['MP', 'northern mariana islands'],
  ['MQ', 'martinique'],
  ['MR', 'mauritania'],
  ['MS', 'montserrat'],
  ['MT', 'malta'],
  ['MU', 'mauritius'],
  ['MV', 'maldives'],
  ['MW', 'malawi'],
  ['MX', 'mexico'],
  ['MY', 'malaysia'],
  ['MZ', 'mozambique'],
  ['NA', 'namibia'],
  ['NC', 'new caledonia'],
  ['NE', 'niger'],
  ['NF', 'norfolk island'],
  ['NG', 'nigeria'],
  ['NI', 'nicaragua'],
  ['NL', 'netherlands flag holland'],
  ['NO', 'norway'],
  ['NP', 'nepal'],
  ['NR', 'nauru'],
  ['NU', 'niue'],
  ['NZ', 'new zealand'],
  ['OM', 'oman'],
  ['PA', 'panama'],
  ['PE', 'peru'],
  ['PF', 'french polynesia'],
  ['PG', 'papua new guinea'],
  ['PH', 'philippines'],
  ['PK', 'pakistan'],
  ['PL', 'poland'],
  ['PM', 'st pierre and miquelon'],
  ['PN', 'pitcairn islands'],
  ['PR', 'puerto rico'],
  ['PS', 'palestine'],
  ['PT', 'portugal'],
  ['PW', 'palau'],
  ['PY', 'paraguay'],
  ['QA', 'qatar'],
  ['RE', 'reunion'],
  ['RO', 'romania'],
  ['RS', 'serbia'],
  ['RU', 'russia'],
  ['RW', 'rwanda'],
  ['SA', 'saudi arabia'],
  ['SB', 'solomon islands'],
  ['SC', 'seychelles'],
  ['SD', 'sudan'],
  ['SE', 'sweden'],
  ['SG', 'singapore'],
  ['SH', 'st helena'],
  ['SI', 'slovenia'],
  ['SJ', 'svalbard jan mayen'],
  ['SK', 'slovakia'],
  ['SL', 'sierra leone'],
  ['SM', 'san marino'],
  ['SN', 'senegal'],
  ['SO', 'somalia'],
  ['SR', 'suriname'],
  ['SS', 'south sudan'],
  ['ST', 'sao tome and principe'],
  ['SV', 'el salvador'],
  ['SX', 'sint maarten'],
  ['SY', 'syria'],
  ['SZ', 'eswatini swaziland flag swaziland'],
  ['TA', 'tristan da cunha'],
  ['TC', 'turks and caicos'],
  ['TD', 'chad'],
  ['TF', 'french southern territories'],
  ['TG', 'togo'],
  ['TH', 'thailand'],
  ['TJ', 'tajikistan'],
  ['TK', 'tokelau'],
  ['TL', 'timor leste'],
  ['TM', 'turkmenistan'],
  ['TN', 'tunisia'],
  ['TO', 'tonga'],
  ['TR', 'turkey'],
  ['TT', 'trinidad and tobago'],
  ['TV', 'tuvalu'],
  ['TW', 'taiwan'],
  ['TZ', 'tanzania'],
  ['UA', 'ukraine'],
  ['UG', 'uganda'],
  ['UM', 'us minor outlying islands'],
  ['UN', 'united nations'],
  ['US', 'united states usa america flag usa america'],
  ['UY', 'uruguay'],
  ['UZ', 'uzbekistan'],
  ['VA', 'vatican'],
  ['VC', 'st vincent and grenadines'],
  ['VE', 'venezuela'],
  ['VG', 'british virgin islands'],
  ['VI', 'us virgin islands'],
  ['VN', 'vietnam'],
  ['VU', 'vanuatu'],
  ['WF', 'wallis and futuna'],
  ['WS', 'samoa'],
  ['XK', 'kosovo'],
  ['YE', 'yemen'],
  ['YT', 'mayotte'],
  ['ZA', 'south africa'],
  ['ZM', 'zambia'],
  ['ZW', 'zimbabwe'],
]

/** Build one emoji def per flag: the char is the regional-indicator pair,
 *  names carry the country name + iso code so both search paths hit. */
const FLAG_EMOJIS: EmojiDef[] = FLAG_NAMES.map(([code, names]) => ({
  char: String.fromCodePoint(
    0x1f1e6 + (code.charCodeAt(0) - 65),
    0x1f1e6 + (code.charCodeAt(1) - 65)
  ),
  names: `${names} ${code.toLowerCase()} flag`,
}))

CATEGORIES.push({ id: 'flags', label: 'Flags', emojis: FLAG_EMOJIS })

const RECENTS_KEY = 'hyperchat-recent-emojis'
const RECENTS_MAX = 24
const USAGE_KEY = 'hyperchat-emoji-usage'

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e === 'string') : []
  } catch {
    return []
  }
}

function saveRecents(emojis: string[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(emojis.slice(0, RECENTS_MAX)))
  } catch {
    // storage is best-effort
  }
}

export function rememberRecent(emoji: string) {
  const next = [emoji, ...loadRecents().filter((e) => e !== emoji)]
  saveRecents(next)
  usageStoreVersion++
}

/** Usage-count map powering the "most used" quick-reaction bar. */
function loadUsage(): Record<string, number> {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function rememberUsage(emoji: string) {
  try {
    const usage = loadUsage()
    usage[emoji] = (usage[emoji] ?? 0) + 1
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage))
    usageStoreVersion++
  } catch {
    // best-effort
  }
}

/** Generation of the usage/recents stores: bumped by every write so the
 *  mostUsedEmojis cache below knows when to recompute. */
let usageStoreVersion = 0

/** The N emojis most worth offering, ranked by an average of lifetime usage
 *  and recent activity: a workhorse you stopped using loses ground to the
 *  one you keep reaching for this week. Custom `:name:` tokens are filtered
 *  against the emoji registry, so suggestions never offer reactions the
 *  current room would reject. Defaults pad the bar so it never collapses
 *  to a single option after one lucky click. Suggestion bars re-rank on
 *  menu open/close (notifyEmojiMenuToggled), not on every use.
 *  Memoized per (store version, registry version, count): every mounted
 *  toolbar asks on every menu toggle, and 100 localStorage reads per event
 *  was its own lag source. */
const quickBarCache = new Map<string, string[]>()
export function mostUsedEmojis(count = 4): string[] {
  const cacheKey = `${usageStoreVersion}:${getServerEmojiVersion()}:${count}`
  const cached = quickBarCache.get(cacheKey)
  if (cached) return cached
  const usage = loadUsage()
  const recents = loadRecents()
  const entries = Object.entries(usage).filter(([emoji]) => availableForQuickBar(emoji))
  const maxCount = Math.max(1, ...entries.map(([, c]) => c))
  // recency rank: index 0 = just used, falls off after a dozen spots
  const recencyOf = new Map<string, number>()
  recents.slice(0, 12).forEach((char, idx) => recencyOf.set(char, (12 - idx) / 12))

  const scored = entries.map(([emoji, c]) => ({
    emoji,
    score: 0.55 * (c / maxCount) + 0.45 * (recencyOf.get(emoji) ?? 0),
  }))
  scored.sort((a, b) => b.score - a.score)

  const seen = new Set<string>()
  const out: string[] = []
  for (const emoji of [...scored.map((s) => s.emoji), ...QUICK_DEFAULTS]) {
    if (out.length >= count) break
    if (seen.has(emoji)) continue
    seen.add(emoji)
    out.push(emoji)
  }
  // single-slot cache: only the newest generation is ever needed
  quickBarCache.clear()
  quickBarCache.set(cacheKey, out)
  return out
}

/** A suggestion token is only offered when the room can actually use it:
 *  unicode always passes, custom `:name:` must resolve in the active
 *  registry (empty in DMs, so custom emoji drop out there). */
function availableForQuickBar(emoji: string): boolean {
  if (!emoji.startsWith(':')) return true
  return !!lookupServerEmoji(emoji)
}

const QUICK_DEFAULTS = ['👍', '❤️', '😂', '🔥']

/** Suggestion bars (hover toolbar, emoji pop QuickRow) listen for this and
 *  re-rank only when an emoji menu actually opens or closes: the ranking
 *  is time+usage averaged, and mid-session churn every click felt noisy. */
export function notifyEmojiMenuToggled() {
  window.dispatchEvent(new CustomEvent('hyperchat-emoji-menu'))
}

/** Flat shortcode index for :name: autocomplete. First keyword of each
 *  emoji is its canonical short name. */
const SHORTCODE_INDEX: { char: string; code: string; names: string }[] = CATEGORIES.flatMap((cat) =>
  cat.emojis.map((e) => ({
    char: e.char,
    code: e.names.split(' ')[0],
    names: e.names,
  }))
)

/** Lookup shortcode matches for the :query being typed. Prefix matches on
 *  the canonical code rank first, then substring, then keywords. */
export function searchShortcodes(query: string, limit = 8): { char: string; code: string }[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const seen = new Set<string>()
  const out: { char: string; code: string }[] = []
  const push = (e: { char: string; code: string }) => {
    if (!seen.has(e.char)) {
      seen.add(e.char)
      out.push({ char: e.char, code: e.code })
    }
  }
  // tier 1: the code starts with the query (":fi" -> fire, fingers)
  for (const e of SHORTCODE_INDEX) {
    if (out.length >= limit) break
    if (e.code.startsWith(q)) push(e)
  }
  // tier 2: the code contains the query
  for (const e of SHORTCODE_INDEX) {
    if (out.length >= limit) break
    if (e.code.includes(q)) push(e)
  }
  // tier 3: keyword matches
  for (const e of SHORTCODE_INDEX) {
    if (out.length >= limit) break
    if (e.names.includes(q)) push(e)
  }
  return out.slice(0, limit)
}

/** Exact :code: lookup: the moment a token closes with its second colon,
 *  this resolves straight to the emoji so the composer can swap it in. */
export function exactShortcode(code: string): { char: string; code: string } | null {
  const hit = SHORTCODE_INDEX.find((e) => e.code === code)
  return hit ?? null
}

/** Replace :code: tokens with literal emoji characters on send.
 *  Expanded shortcodes count toward usage so the quick bar learns from them.
 *  Custom server emoji names stay literal — they render as images at read
 *  time, so the token must survive the send. */
export function expandShortcodes(text: string): string {
  if (!text.includes(':')) return text
  return text.replace(/:([a-z0-9_+\-]+):/gi, (whole, code: string) => {
    if (isServerEmojiName(code.toLowerCase())) return whole
    const hit = SHORTCODE_INDEX.find((e) => e.code === code.toLowerCase())
    if (hit) {
      queueMicrotask(() => {
        rememberUsage(hit.char)
        rememberRecent(hit.char)
      })
      return hit.char
    }
    return whole
  })
}

/** Panel sizing shared by the composer picker and the reaction grid. */
const PANEL_WIDTH = 'w-[min(420px,calc(100vw-2rem))]'
const PANEL_SHELL = cn(PANEL_WIDTH, 'max-h-[380px] flex flex-col rounded-sm')

/** Sticky lowercase label that separates the sections of the long emoji list. */
function SectionHeader({ children }: { children: string }) {
  return (
    <h4 className="sticky top-0 z-10 bg-popover/95 backdrop-blur-sm border-b border-white/[0.06] px-2 py-1 text-[10px] font-bold tracking-widest text-muted-foreground">
      {children.toLowerCase()}
    </h4>
  )
}

/** The emoji cell grid: ~36px cells, keyword aria-labels, hover highlight.
 *  Memoized: the category data never changes, so re-renders only happen
 *  when the pick callback identity changes (it is stabilized upstream). */
const EmojiCells = memo(function EmojiCells({ emojis, onPick }: { emojis: EmojiDef[]; onPick: (emoji: string) => void }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(36px,1fr))] gap-0.5 pt-1">
      {emojis.map((e, i) => (
        <button
          key={`${e.char}-${i}`}
          type="button"
          onClick={() => onPick(e.char)}
          className="aspect-square grid place-items-center rounded-sm text-[22px] leading-none hover:bg-accent"
          aria-label={e.names.split(' ')[0] || 'emoji'}
        >
          <EmojiText emoji={e.char} />
        </button>
      ))}
    </div>
  )
})

/** A category section that only mounts its buttons once it scrolls near
 *  the viewport. Before that it reserves an estimated-height placeholder,
 *  so opening the picker mounts a couple of sections instead of all ~600
 *  buttons at once. This is the emoji tab lag fix. */
const LazySection = memo(function LazySection({ label, emojis, onPick, forceMounted }: { label: string; emojis: EmojiDef[]; onPick: (emoji: string) => void; forceMounted?: boolean }) {
  const [mounted, setMounted] = useState(!!forceMounted)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // prewarm arriving late (idle fired after the section had already mounted
  // lazily): force-mount everything in the same commit. Without this the
  // prewarm flag changes a prop nobody re-reads and the grid never warms.
  if (forceMounted && !mounted) setMounted(true)

  useEffect(() => {
    if (mounted) return
    const el = sentinelRef.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      queueMicrotask(() => setMounted(true))
      return
    }
    // generous-but-bounded root margin: sections mount just before they
    // scroll into view instead of all at once (the old 600px margin covered
    // the entire panel, defeating the laziness and janking open)
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) {
          setMounted(true)
          io.disconnect()
        }
      },
      { root: el.closest('.emoji-scroll') as HTMLElement | null, rootMargin: '120px 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [mounted])

  // ~36px cell rows, ~11 per row at 420px width
  const rows = Math.ceil(emojis.length / 11)
  const estimate = 8 + rows * 37

  return (
    <section aria-label={label}>
      <SectionHeader>{label}</SectionHeader>
      {mounted ? (
        <EmojiCells emojis={emojis} onPick={onPick} />
      ) : (
        <div
          ref={sentinelRef}
          style={{ height: estimate, contentVisibility: 'auto', containIntrinsicSize: `auto ${estimate}px` }}
          className="pt-1"
          aria-hidden="true"
        />
      )}
    </section>
  )
})

/**
 * The emoji browser: search on top, one long scrollable list with sticky
 * section headers (RECENT first, then every category). No category tab bar.
 * `afterPick` lets the composer popover close itself after a pick; the
 * reaction popover (EmojiGrid) leaves it undefined and stays open.
 */
function EmojiBrowser({
  onPick,
  afterPick,
  prewarm,
}: {
  onPick: (emoji: string) => void
  afterPick?: () => void
  /** idle-time pre-warm: every section mounts immediately (the picker is
   *  hidden), so opening it later is a pure visibility flip with zero
   *  button-mount jank */
  prewarm?: boolean
}) {
  const [query, setQuery] = useState('')
  const [recents, setRecents] = useState<string[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  // custom emoji of the active server ride above the unicode categories
  const activeServerId = useChatStore((s) => s.activeServerId)
  const serverName = useChatStore((s) => (s.activeServerId ? s.servers.find((sv) => sv.id === s.activeServerId)?.name : null))
  // stable fallback: a fresh [] inside the selector breaks getSnapshot
  // caching and loops React (Maximum update depth) on servers with no
  // custom emoji loaded
  const customEmoji = useChatStore((s) => (s.activeServerId ? s.serverEmoji[s.activeServerId] : undefined)) ?? EMPTY_EMOJI_LIST
  const customDefs = useMemo(
    () => customEmoji.map((e) => ({ char: `:${e.name}:`, names: e.name })),
    [customEmoji]
  )

  // load recents after mount so SSR markup stays deterministic
  useEffect(() => {
    const t = setTimeout(() => setRecents(loadRecents()), 0)
    return () => clearTimeout(t)
  }, [])

  const allEmojis = useMemo(() => CATEGORIES.flatMap((cat) => cat.emojis), [])
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    // :code: search jumps straight to the shortcode index (custom first)
    if (q.startsWith(':')) {
      const bare = q.slice(1).replace(/:$/, '')
      const customHits = customDefs.filter((c) => c.names.includes(bare))
      const hits = searchShortcodes(bare, 60)
      return [...customHits, ...hits.map((h) => ({ char: h.char, names: h.code }))]
    }
    const customHits = customDefs.filter((c) => c.names.includes(q))
    const unicodeHits = allEmojis.filter((e) => e.names.includes(q) || e.char === q).slice(0, 60)
    return [...customHits, ...unicodeHits]
  }, [query, allEmojis, customDefs])

  const recentDefs = useMemo(() => {
    if (!recents.length) return []
    const map = new Map(allEmojis.map((e) => [e.char, e]))
    return recents.map((char) => map.get(char) ?? { char, names: '' })
  }, [recents, allEmojis])

  // snap back to the top whenever the flat search list swaps in
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
  }, [query])

  const pick = useCallback((emoji: string) => {
    sounds.play('lightTick')
    rememberRecent(emoji)
    rememberUsage(emoji)
    setRecents(loadRecents())
    onPick(emoji)
    afterPick?.()
  }, [onPick, afterPick])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-1.5 py-1.5 border-b border-white/[0.06]">
        <Search className="size-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search emoji or :code"
          aria-label="search emoji"
          className="flex-1 min-w-0 bg-app-raise border border-white/10 rounded-sm px-2 py-1 text-sm outline-none focus:border-hyper/60 placeholder:text-muted-foreground"
        />
      </div>
      <div
        ref={listRef}
        className="emoji-scroll flex-1 min-h-0 overflow-y-auto scroll-thin scroll-smooth px-1.5 pb-1.5"
        role="listbox"
        aria-label="emoji"
      >
        {results ? (
          results.length ? (
            <div className="pt-1.5">
              <EmojiCells emojis={results} onPick={pick} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-6">No results.</p>
          )
        ) : (
          <>
            {customDefs.length > 0 && (
              <section aria-label={serverName ?? 'custom emoji'}>
                <SectionHeader>{serverName ?? 'custom'}</SectionHeader>
                <EmojiCells emojis={customDefs} onPick={pick} />
              </section>
            )}
            {recentDefs.length > 0 && (
              <section aria-label="recent">
                <SectionHeader>Recent</SectionHeader>
                <EmojiCells emojis={recentDefs} onPick={pick} />
              </section>
            )}
            {CATEGORIES.map((cat) => (
              <LazySection key={cat.id} label={cat.label} emojis={cat.emojis} onPick={pick} forceMounted={prewarm} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function isGifList(data: unknown): data is { gifs: GifResult[] } {
  if (typeof data !== 'object' || data === null) return false
  const gifs = (data as { gifs?: unknown }).gifs
  if (!Array.isArray(gifs)) return false
  return gifs.every(
    (g) =>
      typeof g === 'object' &&
      g !== null &&
      typeof (g as GifResult).id === 'string' &&
      typeof (g as GifResult).url === 'string' &&
      typeof (g as GifResult).title === 'string'
  )
}

/**
 * The GIF half of the picker: debounced search against /api/gifs with lazy
 * image loading, skeleton cells, offset pagination ("load more"), and a
 * personal saved section (GIFs kept from other people's messages). Picking
 * hands {url, title} upstream.
 */
function GifTab({ onPick, open }: { onPick: (gif: GifPick) => void; open: boolean }) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [gifs, setGifs] = useState<GifResult[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loaded, setLoaded] = useState<Set<string>>(new Set())
  // saved gifs: always pinned to the top of the default view, one remove
  // button away from tidying. search replaces discovery, so the pinned
  // section steps aside while a query is live
  const [saved, setSaved] = useState<GifResult[]>([])

  // debounce the raw query so typing does not hammer the endpoint
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  // fetch whenever the debounced query settles (mount included)
  useEffect(() => {
    const ctrl = new AbortController()
    let alive = true
    setLoading(true)
    ;(async () => {
      try {
        const res = await fetch(`/api/gifs?q=${encodeURIComponent(debounced)}`, {
          signal: ctrl.signal,
        })
        if (!res.ok) throw new Error('gif search failed')
        const data: unknown = await res.json()
        if (alive && isGifList(data)) {
          setGifs(data.gifs)
          setHasMore(!!(data as { more?: boolean }).more)
        } else if (alive) {
          setGifs([])
          setHasMore(false)
        }
      } catch {
        if (alive && !ctrl.signal.aborted) {
          setGifs([])
          setHasMore(false)
        }
      } finally {
        if (alive && !ctrl.signal.aborted) setLoading(false)
      }
    })()
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [debounced])

  // the saved section loads once per picker lifetime and refreshes every
  // time the popover reopens (gifs saved from a lightbox while it was closed)
  const refreshSaved = useCallback(() => {
    void apiClient
      .savedGifs()
      .then((res) => setSaved(res.gifs))
      .catch(() => setSaved([]))
  }, [])
  useEffect(() => {
    if (open) refreshSaved()
  }, [open, refreshSaved])

  async function loadMore() {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/gifs?q=${encodeURIComponent(debounced)}&offset=${gifs.length}`)
      const data: unknown = await res.json()
      if (res.ok && isGifList(data)) {
        const incoming = data.gifs.filter((g) => !gifs.some((cur) => cur.id === g.id))
        setGifs((cur) => [...cur, ...incoming])
        setHasMore(!!(data as { more?: boolean }).more && incoming.length > 0)
      } else {
        setHasMore(false)
      }
    } catch {
      setHasMore(false)
    } finally {
      setLoadingMore(false)
    }
  }

  function pick(gif: GifResult) {
    sounds.play('lightTick')
    onPick({ url: gif.url, title: gif.title })
  }

  function removeSaved(gif: GifResult) {
    sounds.play('midTick')
    setSaved((cur) => cur.filter((g) => g.url !== gif.url))
    void apiClient.removeSavedGif(gif.url).catch(() => refreshSaved())
  }

  const markLoaded = (id: string) => {
    setLoaded((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }

  // the pinned saved section only exists in the default view; ANY text in
  // the search box unpins instantly (the debounced fetch follows behind),
  // and clearing the box pins them back. saved urls also drop out of the
  // live grid below while pinned so nothing renders twice; while searching
  // they sit wherever they naturally match
  const savedUrls = new Set(saved.map((g) => g.url))
  const showSavedSection = !query.trim() && saved.length > 0
  const grid = gifs.filter((g) => !showSavedSection || !savedUrls.has(g.url))
  const showLoadMore = !loading && grid.length > 0 && hasMore

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-1.5 py-1.5 border-b border-white/[0.06]">
        <Search className="size-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search gifs"
          aria-label="search GIFs"
          className="flex-1 min-w-0 bg-app-raise border border-white/10 rounded-sm px-2 py-1 text-sm outline-none focus:border-hyper/60 placeholder:text-muted-foreground"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scroll-thin p-1.5">
        {/* saved gifs pinned to the top of the default view: the ones you
            kept are the ones you reach for first. any text in the search
            box unpins them — searching is discovery, so results order on
            their own and saved gifs sit wherever they match */}
        {showSavedSection && (
          <div className="mb-2">
            <p className="flex items-center gap-1.5 px-0.5 pb-1.5 text-[10px] font-bold tracking-widest text-hyper/80">
              <Bookmark className="size-3" aria-hidden="true" />
              saved
              <span className="font-normal tracking-normal text-muted-foreground">{saved.length}</span>
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
              {saved.map((gif) => (
                <button
                  key={`s-${gif.id}`}
                  type="button"
                  onClick={() => pick(gif)}
                  className="group/gif relative aspect-[4/3] rounded-sm overflow-hidden hover:ring-1 hover:ring-hyper transition cursor-pointer"
                  aria-label={gif.title}
                  title={gif.title}
                >
                  {!loaded.has(`s-${gif.id}`) && (
                    <span className="absolute inset-0 bg-app-raise animate-pulse" aria-hidden="true" />
                  )}
                  <img
                    src={gif.preview ?? gif.url}
                    alt={gif.title}
                    loading="lazy"
                    decoding="async"
                    onLoad={() => markLoaded(`s-${gif.id}`)}
                    onError={() => markLoaded(`s-${gif.id}`)}
                    className="absolute inset-0 size-full object-cover"
                  />
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Remove ${gif.title} from saved`}
                    onClick={(e) => {
                      e.stopPropagation()
                      removeSaved(gif)
                    }}
                    className="absolute top-1 right-1 p-1 rounded-sm bg-black/70 text-foreground/80 opacity-0 group-hover/gif:opacity-100 focus-visible:opacity-100 transition-opacity"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </span>
                </button>
              ))}
            </div>
            <div className="h-px bg-white/[0.07] mt-2.5 mb-0.5" aria-hidden="true" />
          </div>
        )}
        {loading && gifs.length === 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className="aspect-[4/3] rounded-sm bg-app-raise animate-pulse" />
            ))}
          </div>
        ) : grid.length === 0 && !showSavedSection ? (
          <p className="text-xs text-muted-foreground text-center py-6">no gifs found</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
            {grid.map((gif) => (
              <button
                key={gif.id}
                type="button"
                onClick={() => pick(gif)}
                className="group/gif relative aspect-[4/3] rounded-sm overflow-hidden hover:ring-1 hover:ring-hyper transition cursor-pointer"
                aria-label={gif.title}
                title={gif.title}
              >
                {!loaded.has(gif.id) && (
                  <span className="absolute inset-0 bg-app-raise animate-pulse" aria-hidden="true" />
                )}
                <img
                  src={gif.preview ?? gif.url}
                  alt={gif.title}
                  loading="lazy"
                  decoding="async"
                  onLoad={() => markLoaded(gif.id)}
                  onError={() => markLoaded(gif.id)}
                  className="absolute inset-0 size-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
        {showLoadMore && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="mt-1 mb-1 w-full py-1.5 text-[11px] font-semibold rounded-sm border border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25 transition-colors disabled:opacity-50"
          >
            {loadingMore ? 'loading' : 'load more'}
          </button>
        )}
      </div>
    </div>
  )
}


/** The stickers half of the picker: the ACTIVE server's sticker uploads.
 *  Clicking one sends it whole, Discord-style. There is no default set —
 *  every sticker here is a file one of the server's admins uploaded.
 *  Admins (Manage Server) get the add row + per-cell remove. */
function StickerTab({ onPick, open }: { onPick: (sticker: StickerSummary) => void; open: boolean }) {
  const activeServerId = useChatStore((s) => s.activeServerId)
  const stickers = useChatStore((s) => (s.activeServerId ? s.serverStickers[s.activeServerId] : undefined)) ?? EMPTY_STICKER_LIST
  const canManage = useChatStore((s) => {
    if (!s.activeServerId) return false
    const perms = s.servers.find((sv) => sv.id === s.activeServerId)?.myPerms ?? 0
    return hasPerm(perms, PERM.MANAGE_SERVER)
  })
  const addServerSticker = useChatStore((s) => s.addServerSticker)
  const removeServerSticker = useChatStore((s) => s.removeServerSticker)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // refetch every time the popover reopens so a fresh upload by another
  // admin shows up without a page reload
  const refreshServerStickers = useChatStore((s) => s.refreshServerStickers)
  useEffect(() => {
    if (open && activeServerId) void refreshServerStickers(activeServerId)
  }, [open, activeServerId, refreshServerStickers])

  async function onFile(file: File | null) {
    if (!file || !activeServerId || busy) return
    setBusy(true)
    // file name minus extension becomes the sticker name (1-32 chars)
    const base = file.name.replace(/\.[^.]+$/, '').trim().slice(0, 32) || 'sticker'
    const ok = await addServerSticker(activeServerId, file, base)
    setBusy(false)
    if (ok) sounds.play('lightTick')
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-thin p-1.5">
      {canManage && (
        <div className="mb-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/gif,image/webp,image/jpeg"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => {
              void onFile(e.target.files?.[0] ?? null)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-sm border border-dashed border-white/15 text-[11px] font-semibold text-muted-foreground hover:text-hyper hover:border-hyper/60 transition-colors disabled:opacity-50"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {busy ? 'uploading' : 'add sticker'}
          </button>
          <div className="h-px bg-white/[0.07] mt-2.5 mb-0.5" aria-hidden="true" />
        </div>
      )}
      {stickers.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-6 px-3">
          no stickers yet{canManage ? ' — add one above (png, gif, webp or jpg under 1 MB)' : '. a server admin has to add some.'}
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-1">
          {stickers.map((st) => (
            <div key={st.id} className="group/st relative">
              <button
                type="button"
                onClick={() => {
                  sounds.play('lightTick')
                  onPick(st)
                }}
                className="w-full aspect-square rounded-sm overflow-hidden bg-app-raise/50 hover:ring-1 hover:ring-hyper transition grid place-items-center p-1.5 cursor-pointer"
                aria-label={`send sticker ${st.name}`}
                title={st.name}
              >
                <img
                  src={st.url}
                  alt={st.name}
                  loading="lazy"
                  decoding="async"
                  className="max-w-full max-h-full object-contain"
                />
              </button>
              {canManage && (
                <button
                  type="button"
                  onClick={() => activeServerId && void removeServerSticker(activeServerId, st.id)}
                  className="absolute top-1 right-1 p-1 rounded-sm bg-black/70 text-foreground/80 opacity-0 group-hover/st:opacity-100 focus-visible:opacity-100 transition-opacity"
                  aria-label={`remove sticker ${st.name}`}
                  title={`remove ${st.name}`}
                >
                  <Trash2 className="size-3" aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The reaction picker body: search + single long list with sticky headers. */
export function EmojiGrid({ onPick, prewarm }: { onPick: (emoji: string) => void; prewarm?: boolean }) {
  return (
    <div className={PANEL_SHELL} role="dialog" aria-label="emoji picker">
      <EmojiBrowser onPick={onPick} prewarm={prewarm} />
    </div>
  )
}

/** Trigger button + popover wrapper for the message input. When `onGif` is
 *  provided the popover gains an EMOJI / GIFS segmented toggle on top.
 *  `initialMode="gifs"` turns the whole trigger into a dedicated GIF button
 *  that opens straight into the GIF tab. */
export function EmojiPicker({
  onPick,
  onGif,
  onSticker,
  initialMode,
  openRequest,
}: {
  onPick: (emoji: string) => void
  onGif?: (gif: GifPick) => void
  /** stickers send whole (server channels only): providing this adds the
   *  STICKERS tab */
  onSticker?: (sticker: StickerSummary) => void
  initialMode?: 'emoji' | 'gifs'
  /** external open requests (e.g. the composer's "+" menu opening the gif
   *  tab): bump `at` to open; the mode rides along */
  openRequest?: { mode: 'emoji' | 'gifs' | 'stickers'; at: number }
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'emoji' | 'gifs' | 'stickers'>(initialMode ?? 'emoji')
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gifFirst = initialMode === 'gifs'
  // keep-alive: the panel mounts during IDLE time after app load (not just
  // after first use), so every real open — including the very first — is a
  // pure visibility flip instead of a mount stampede of ~600 buttons.
  // The popover itself opens with no zoom/slide animation: a utility menu
  // that appears in the same frame as the click reads as instant.
  const [prewarmed, setPrewarmed] = useState(false)
  const [appliedRequestAt, setAppliedRequestAt] = useState(0)
  // external open requests (from the "+" menu): render-phase adjust, so the
  // request state and the open state land in the same commit
  if (openRequest && openRequest.at !== appliedRequestAt) {
    setAppliedRequestAt(openRequest.at)
    setMode(openRequest.mode)
    setOpen(true)
  }

  useEffect(() => {
    if (prewarmed) return
    const idle = (cb: () => void) =>
      'requestIdleCallback' in window ? window.requestIdleCallback(cb, { timeout: 2200 }) : setTimeout(cb, 700)
    const t = idle(() => setPrewarmed(true))
    return () => {
      if ('cancelIdleCallback' in window) window.cancelIdleCallback(t as number)
    }
  }, [prewarmed])

  // the quick-reaction ranking re-computes on menu open/close only
  useEffect(() => {
    notifyEmojiMenuToggled()
    return () => notifyEmojiMenuToggled()
  }, [open])

  // same delayed close that stops the pick-click from flickering the popover
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 80)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (closeTimer.current) {
          clearTimeout(closeTimer.current)
          closeTimer.current = null
        }
        if (!next) {
          closeTimer.current = setTimeout(() => setOpen(false), 80)
        } else {
          setMode(initialMode ?? 'emoji')
          setOpen(true)
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={cn(
            'p-2 max-md:p-2.5 rounded-sm transition-colors shrink-0',
            gifFirst
              ? 'text-muted-foreground hover:text-hyper hover:bg-hyper/10'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          )}
          aria-label={gifFirst ? 'Send a GIF' : 'Insert an emoji'}
          title={gifFirst ? 'Send a GIF' : 'Insert an emoji'}
        >
          {gifFirst ? <Film className="size-5" /> : <Smile className="size-5" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        keepMounted
        className="w-auto p-0 rounded-sm data-[state=closed]:hidden data-[state=closed]:animate-none data-[state=open]:animate-none"
        side="top"
        align="start"
        aria-describedby={undefined}
      >
        <div
          className={cn(PANEL_SHELL, !open && 'hidden')}
          role="dialog"
          aria-label="emoji picker"
        >
          {onGif && (
            <div className="px-1.5 pt-1.5">
              <div
                className={cn('w-full grid p-1 bg-app-raise rounded-sm', onSticker ? 'grid-cols-3' : 'grid-cols-2')}
                role="tablist"
                aria-label="picker mode"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'emoji'}
                  onClick={() => setMode('emoji')}
                  className={cn(
                    'py-1 text-[11px] font-semibold tracking-wide rounded-sm transition-colors',
                    mode === 'emoji'
                      ? 'bg-popover text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  emoji
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'gifs'}
                  onClick={() => setMode('gifs')}
                  className={cn(
                    'py-1 text-[11px] font-semibold tracking-wide rounded-sm transition-colors',
                    mode === 'gifs'
                      ? 'bg-popover text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  gifs
                </button>
                {onSticker && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'stickers'}
                    onClick={() => setMode('stickers')}
                    className={cn(
                      'py-1 text-[11px] font-semibold tracking-wide rounded-sm transition-colors',
                      mode === 'stickers'
                        ? 'bg-popover text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    stickers
                  </button>
                )}
              </div>
            </div>
          )}
          {mode === 'gifs' && onGif ? (
            <GifTab
              open={open}
              onPick={(gif) => {
                onGif(gif)
                scheduleClose()
              }}
            />
          ) : mode === 'stickers' && onSticker ? (
            <StickerTab
              open={open}
              onPick={(sticker) => {
                onSticker(sticker)
                scheduleClose()
              }}
            />
          ) : (
            <EmojiBrowser onPick={onPick} afterPick={scheduleClose} prewarm={prewarmed} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Small preset row used by the reaction picker. */
export function ReactionPalette({ onPick, onMore }: { onPick: (emoji: string) => void; onMore?: () => void }) {
  const presets = ['👍', '👎', '❤️', '😂', '😮', '😢', '🔥', '🎉']
  return (
    <div className="flex gap-0.5 items-center">
      {presets.map((emoji) => (
        <button
          key={emoji}
          onClick={() => onPick(emoji)}
          className="size-8 max-[480px]:size-10 grid place-items-center rounded-sm text-lg hover:bg-accent transition-colors"
          aria-label={`React with ${emoji}`}
        >
          {emoji}
        </button>
      ))}
      {onMore && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 rounded-sm text-muted-foreground"
          onClick={onMore}
          aria-label="more reactions"
          title="more reactions"
        >
          <Smile className="size-4" />
        </Button>
      )}
    </div>
  )
}

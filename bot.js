require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  ButtonStyle,
  EmbedBuilder,
  REST,
  Routes,
} = require("discord.js");
const fs = require("fs").promises;
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} = require("@discordjs/voice");
const play = require("play-dl");

play.getFreeClientID().then((clientID) => {
  play.setToken({
    soundcloud : {
      client_id : clientID
    }
  })
})

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const commands = [
  {
    name: "checklol",
    description:
      "Checks for members currently playing League of Legends, and asks them to stop playing.",
  },
  {
    name: "play",
    description: "Play music from Soundcloud",
    options: [
      {
        name: "url",
        type: 3, // STRING
        description: "The Soundcloud URL of the song to play",
        required: true,
      },
    ],
  },
  {
    name: "playnext",
    description: "Play a new song or queue item next",
    options: [
      {
        name: "url",
        type: 3, // STRING
        description: "The Soundcloud URL of the song to play",
        required: false,
      },
      {
        name: "index",
        type: 4, // INTEGER
        description: "The song in queue to play next",
        required: false,
      },
    ],
  },
  {
    name: "stop",
    description: "Stop the currently playing music and disconnect the bot",
  },
  {
    name: "pause",
    description: "Pauses the currently playing music",
  },
  {
    name: "resume",
    description: "Resumes the currently playing music",
  },
  {
    name: "nowplaying",
    description: "Shows the currently playing song",
  },
  {
    name: "reorder",
    description: "Moves a song in queue to a new location",
    options: [
      {
        name: "from",
        type: 4, // INTEGER
        description: "Current Position",
        required: true,
      },
      {
        name: "to",
        type: 4, // INTEGER
        description: "New Position",
        required: true,
      },
    ],
  },
  {
    name: "setvolume",
    description: "Set the volume of the currently playing audio",
    options: [
      {
        name: "percentage",
        type: 4, // INTEGER
        description: "Volume percentage (1-100)",
        required: true,
        min_value: 1,
        max_value: 100,
      },
    ],
  },
  {
    name: "queue",
    description: "Display the current song queue",
  },
  {
    name: "skip",
    description: "Skip the currently playing song",
  },
  {
    name: "remove",
    description: "Remove a song or range of songs from the queue",
    options: [
      {
        name: "range",
        type: 3, // STRING
        description: "Song number or range to remove (e.g., 2 or 2-4)",
        required: true,
      },
    ],
  },
  {
    name: "shuffle",
    description: "Shuffle the current queue",
  },
  {
    name: "loop",
    description: "Toggle queue looping on or off",
  },
  {
    name: "getvolume",
    description: "Get the current volume setting",
  },
];

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const rest = new REST({ version: "10" }).setToken(TOKEN);
client.on("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}!`);

  // Register slash commands
  (async () => {
    try {
      console.log("Started refreshing application (/) commands.");

      // Register slash commands in every guild the bot is in
      for (const [guildId, guild] of client.guilds.cache) {
        try {
          await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), {
            body: commands,
          });
          console.log(`✅ Registered commands in ${guild.name} (${guildId})`);
        } catch (err) {
          console.error(`❌ Failed to register commands in ${guild.name}:`, err);
        }
      }

      console.log("Successfully reloaded application (/) commands.");
    } catch (error) {
      console.error(error);
    }
  })();
});

const membersPlayingLoL = new Map();

const players = new Map();

class Queue {
  constructor() {
    this.items = [];
    this.looping = false;
  }

  add(item) {
    this.items.push(item);
  }

  remove(start, end = start) {
    this.items.splice(start, end - start);
  }

  skip() {
    const skipped = this.items.shift();
    if (this.looping && skipped) {
        this.items.push(skipped);
    }
    return skipped;
}

  shuffle() {
    if (this.items.length <= 1) return; // No need to shuffle if there's only one or no songs

    const currentlyPlaying = this.items.shift(); // Remove the first item (currently playing)

    // Shuffle the remaining items
    for (let i = this.items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    }

    this.items.unshift(currentlyPlaying); // Add the currently playing song back to the front
  }

  toggleLoop() {
    this.looping = !this.looping;
    return this.looping;
  }

  get() {
    return this.items;
  }
}

const queues = new Map();
const guildVolumes = new Map();

async function playNext(guild, queue) {
  if (!queue || queue.get().length === 0) return;

  const nextSong = queue.get()[0];
  const playerInfo = players.get(guild.id);
  if (!playerInfo) return;

  // Clear any previous update interval for this player (avoid editing stale messages)
  if (playerInfo.nowPlayingInterval) {
    try { clearInterval(playerInfo.nowPlayingInterval); } catch (e) {}
    playerInfo.nowPlayingInterval = null;
  }

  // Create resource and play
  const resource = createAudioResource(nextSong.stream.stream, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  });

  const volume = guildVolumes.get(guild.id) || 0.5;
  try {
    resource.volume.setVolume(volume/5);
  } catch (e) {
    // ignore volume set errors
  }

  playerInfo.player.play(resource);
  playerInfo.resource = resource;

  // Send Now Playing embed + controls and store the returned Message object
  try {
    const { embed, row } = createNowPlayingEmbed(nextSong, 0);

    // Make sure we have a textChannel
    const textChannel = playerInfo.textChannel;
    if (!textChannel || !textChannel.send) return;

    // send and store the message (await to get the Message object)
    const sent = await textChannel.send({ embeds: [embed], components: [row] });

    // store message id and channel id. prefer Message object but save id for fallback.
    playerInfo.nowPlayingMessage = sent;
    playerInfo.nowPlayingMessageId = sent?.id;
    playerInfo.nowPlayingChannelId = textChannel.id;

    // Create an interval to update elapsed time every 15s
    playerInfo.nowPlayingInterval = setInterval(async () => {
      try {
        // stop if player no longer exists or not playing
        if (!playerInfo || !playerInfo.player || playerInfo.player.state.status !== "playing") {
          clearInterval(playerInfo.nowPlayingInterval);
          playerInfo.nowPlayingInterval = null;
          return;
        }

        // compute elapsed seconds
        const elapsed = Math.floor(playerInfo.player.state.resource.playbackDuration / 1000);

        // get updated embed
        const { embed: updatedEmbed } = createNowPlayingEmbed(nextSong, elapsed);

        // attempt to edit the stored message object if valid
        if (playerInfo.nowPlayingMessage && typeof playerInfo.nowPlayingMessage.edit === "function") {
          await playerInfo.nowPlayingMessage.edit({ embeds: [updatedEmbed], components: [row] }).catch(() => {});
        } else {
          // fallback: fetch the message from the channel and edit it
          const ch = await guild.channels.fetch(playerInfo.nowPlayingChannelId).catch(() => null);
          if (ch && ch.isTextBased()) {
            const msg = await ch.messages.fetch(playerInfo.nowPlayingMessageId).catch(() => null);
            if (msg && typeof msg.edit === "function") {
              await msg.edit({ embeds: [updatedEmbed], components: [row] }).catch(() => {});
              // update stored message reference
              playerInfo.nowPlayingMessage = msg;
            }
          }
        }
      } catch (err) {
        // If anything goes wrong while editing, just stop the interval to avoid noisy errors
        clearInterval(playerInfo.nowPlayingInterval);
        playerInfo.nowPlayingInterval = null;
      }
    }, 15000); // 15s
  } catch (err) {
    console.error("Failed to send/update Now Playing message:", err);
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function createNowPlayingEmbed(song, elapsedSecs = 0) {
  // Ensure values are primitive strings
  const artistName =
    typeof song.artist === "object"
      ? song.artist.name || "Unknown Artist"
      : song.artist || "Unknown Artist";

  const title = typeof song.title === "string" ? song.title : String(song.title);
  const url = typeof song.url === "string" ? song.url : undefined;
  const thumb = typeof song.thumbnail === "string" ? song.thumbnail : null;
  const duration = Number(song.durationInSec) || 0;

  // Build the embed
  const embed = new EmbedBuilder()
    .setColor(0xcdf69c)
    .setTitle(`🎶 Now Playing: ${title}`)
    .setURL(url)
    .setThumbnail(thumb)
    .addFields(
      { name: "Artist", value: artistName, inline: true },
      {
        name: "Duration",
        value: `${formatTime(elapsedSecs)} / ${formatTime(duration)}`,
        inline: true,
      }
    )
    .setFooter({ text: "Music Player" });

  // Add playback controls
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("pause")
      .setLabel("⏸ Pause")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("resume")
      .setLabel("▶️ Resume")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("stop")
      .setLabel("⏹ Stop")
      .setStyle(ButtonStyle.Danger)
  );

  return { embed, row };
}

// Track when a member's presence updates
client.on("presenceUpdate", (oldPresence, newPresence) => {
  // Check if the user has started or stopped playing League of Legends
  const member = newPresence.member;

  if (!newPresence.activities) return;

  // Check if they are currently playing "League of Legends"
  const isPlayingLoL = newPresence.activities.some(
    (activity) => activity.name === "League of Legends"
  );

  if (isPlayingLoL) {
    // Add member to the cache if playing LoL
    membersPlayingLoL.set(member.id, member);
    console.log(`${member.user.tag} is now playing League of Legends.`);
  } else if (membersPlayingLoL.has(member.id)) {
    // Remove member from the cache if they stop playing LoL
    membersPlayingLoL.delete(member.id);
    console.log(`${member.user.tag} has stopped playing League of Legends.`);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "checklol") {
    try {
      await interaction.deferReply();

      // Check if there are any members currently cached as playing LoL
      if (membersPlayingLoL.size > 0) {
        const mentions = Array.from(membersPlayingLoL.values())
          .map((member) => `<@${member.id}>`)
          .join(", ");

        await interaction.editReply(
          `${mentions}, stop playing League of Legends! >:(`
        );
      } else {
        await interaction.editReply(
          "Nobody is currently playing League of Legends. Yay!"
        );
      }
    } catch (error) {
      console.error("Error handling checklol command:", error);
      await interaction.editReply("An error occurred while fetching members.");
    }
  }

  if (interaction.commandName === "play") {
    const url = interaction.options.getString("url");
    const member = interaction.member;

    if (!member.voice.channel) {
      return interaction.reply(
        "You need to be in a voice channel to use this command!"
      );
    }

    try {
      await interaction.deferReply();

      console.log("Attempting to play:", url);

      let stream;
      let title;
      let artist;
      let durationInSec;
      let thumbnail;

      if (url.includes("soundcloud.com")) {
        console.log("Valid Soundcloud URL");
        const soundcloud_track = await play.soundcloud(url);
        stream = await play.stream(soundcloud_track.url);
        title = soundcloud_track.name;
        artist = soundcloud_track.publisher;
        durationInSec = soundcloud_track.durationInSec;
        thumbnail = soundcloud_track.thumbnail;
      } else {
        return interaction.editReply(
          "Invalid URL. Please provide a valid Soundcloud link."
        );
      }

      console.log("Stream created:", stream);
      console.log("Title:", title);

      const queueItem = { title, durationInSec, stream, thumbnail, artist, url };
      if (!queues.has(interaction.guildId)) {
        queues.set(interaction.guildId, new Queue());
      }
      queues.get(interaction.guildId).add(queueItem);
      if (queues.get(interaction.guildId).get().length > 1) {
        return interaction.editReply(`Added to queue: ${title}`);
      }

      const channel = member.voice.channel;
      console.log("Joining voice channel:", channel.name);
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
      });

      console.log("Voice connection created");

      const player = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause,
        },
      });

      console.log("Audio player created");

      const resource = createAudioResource(stream.stream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
      });

      const playerInfo = {
        player: player,
        connection: connection,
        resource: resource,
        textChannel: interaction.channel,
      };
      players.set(interaction.guildId, playerInfo);

      console.log("Audio resource created");

      const volume = guildVolumes.get(interaction.guildId) || 0.5;
      resource.volume.setVolume(volume/5);

      console.log("Volume set");

      player.play(resource);
      console.log("Player started");

      connection.subscribe(player);
      console.log("Connection subscribed to player");

      player.on(AudioPlayerStatus.Playing, () => {
        console.log("Audio player status: Playing");
      });

      player.on(AudioPlayerStatus.Idle, () => {
        console.log("Audio player status: Idle");
        const queue = queues.get(interaction.guildId);
        const playerInfo = players.get(interaction.guildId);

        if (playerInfo && playerInfo.nowPlayingInterval) {
          clearInterval(playerInfo.nowPlayingInterval);
          playerInfo.nowPlayingInterval = null;
        }

        if (queue && queue.get().length > 0) {
          queue.skip();
          playNext(interaction.guild, queue);
        } else {
          connection.destroy();
          players.delete(interaction.guildId);
        }
      });

      player.on("error", (error) => {
        console.error("Error with audio player:", error);
      });

      const queue = queues.get(interaction.guildId)
      const current = queue.get()[0];

      // Send the now playing embed and store message reference
      try {
        const { embed, row } = createNowPlayingEmbed(current, 0);
        const textChannel = playerInfo.textChannel || interaction.channel;
        const sent = await textChannel.send({ embeds: [embed], components: [row] });

        playerInfo.nowPlayingMessage = sent;
        playerInfo.nowPlayingMessageId = sent.id;
        playerInfo.nowPlayingChannelId = textChannel.id;

        // Clear old interval if one exists
        if (playerInfo.nowPlayingInterval) {
          clearInterval(playerInfo.nowPlayingInterval);
          playerInfo.nowPlayingInterval = null;
        }

        // Update embed every 15s
        playerInfo.nowPlayingInterval = setInterval(async () => {
          try {
            if (playerInfo.player.state.status !== "playing") {
              clearInterval(playerInfo.nowPlayingInterval);
              playerInfo.nowPlayingInterval = null;
              return;
            }

            const elapsed = Math.floor(playerInfo.player.state.resource.playbackDuration / 1000);
            const { embed: updatedEmbed } = createNowPlayingEmbed(current, elapsed);

            if (playerInfo.nowPlayingMessage && typeof playerInfo.nowPlayingMessage.edit === "function") {
              await playerInfo.nowPlayingMessage.edit({ embeds: [updatedEmbed], components: [row] }).catch(() => {});
            } else {
              const ch = await interaction.guild.channels.fetch(playerInfo.nowPlayingChannelId).catch(() => null);
              if (ch && ch.isTextBased()) {
                const msg = await ch.messages.fetch(playerInfo.nowPlayingMessageId).catch(() => null);
                if (msg && typeof msg.edit === "function") {
                  await msg.edit({ embeds: [updatedEmbed], components: [row] }).catch(() => {});
                  playerInfo.nowPlayingMessage = msg;
                }
              }
            }
          } catch (err) {
            clearInterval(playerInfo.nowPlayingInterval);
            playerInfo.nowPlayingInterval = null;
          }
        }, 15000);
      } catch (err) {
        console.error("Failed to send Now Playing message:", err);
      }
    } catch (error) {
      console.error("Error setting up audio:", error);
      await interaction.editReply(
        "An error occurred while setting up the audio. Please try again later."
      );
    }
  }

  if (interaction.commandName === "pause") {
    const playerInfo = players.get(interaction.guildId);
    if (!playerInfo || !playerInfo.player) {
      return interaction.reply("There is no music currently playing.");
    }
    playerInfo.player.pause();
    return interaction.reply("Playback paused.");
  }

  if (interaction.commandName === "resume") {
    const playerInfo = players.get(interaction.guildId);
    if (!playerInfo || !playerInfo.player) {
      return interaction.reply("There is no music currently playing.");
    }
    playerInfo.player.unpause();
    return interaction.reply("Playback resumed.");
  }

  if (interaction.commandName === "reorder") {
    const queue = queues.get(interaction.guildId);
    const from = interaction.options.getInteger("from") - 1;
    const to = interaction.options.getInteger("to") - 1;

    if (!queue || queue.get().length < 2) {
      return interaction.reply("Not enough songs in the queue to reorder.");
    }

    if (from < 1 || from >= queue.get().length || to < 1 || to >= queue.get().length) {
      return interaction.reply("Invalid positions. Use `/queue` to see the list.");
    }

    const items = queue.get();
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    return interaction.reply(`Moved **${moved.title}** from position ${from + 1} to ${to + 1}.`);
  }

  if (interaction.commandName === "playnext") {
    const queue = queues.get(interaction.guildId) || new Queue();
    queues.set(interaction.guildId, queue);

    const url = interaction.options.getString("url");
    const index = interaction.options.getInteger("index");

    if (url) {
      try {
        await interaction.deferReply();

        if (!url.includes("soundcloud.com")) {
          return interaction.editReply("Only SoundCloud URLs are supported.");
        }
        
        const track = await play.soundcloud(url);
        title = track.name
        const stream = await play.stream(track.url);
        artist = track.publisher;
        durationInSec = track.durationInSec;
        thumbnail = track.thumbnail;
        const queueItem = { title, durationInSec, stream, thumbnail, artist, url };

        queue.get().splice(1, 0, queueItem); // Insert right after now playing
        return interaction.editReply(`Added to front of queue: **${track.name}**`);
      } catch (e) {
        console.error(e);
        return interaction.editReply("Failed to load track.");
      }
    } else if (index !== null) {
      const items = queue.get();
      if (index < 1 || index >= items.length) {
        return interaction.reply("Invalid index. Use `/queue` to check.");
      }

      const [moved] = items.splice(index, 1);
      items.splice(1, 0, moved); // After currently playing
      return interaction.reply(`Moved **${moved.title}** to front of queue.`);
    } else {
      return interaction.reply("Provide a SoundCloud URL or a queue index.");
    }
  }

  if (interaction.commandName === "setvolume") {
    const volume = interaction.options.getInteger("percentage");
    const guildId = interaction.guildId;
    const playerInfo = players.get(guildId);

    if (!playerInfo || !playerInfo.player) {
      return interaction.reply("There is no audio currently playing.");
    }

    if (!interaction.member.voice.channel) {
      return interaction.reply(
        "You need to be in a voice channel to use this command."
      );
    }

    if (
      interaction.member.voice.channel.id !==
      playerInfo.connection.joinConfig.channelId
    ) {
      return interaction.reply(
        "You need to be in the same voice channel as the bot to use this command."
      );
    }

    try {
      const volumeValue = volume / 100; // Convert percentage to a value between 0 and 1
      playerInfo.resource.volume.setVolume(volumeValue/5);
      guildVolumes.set(guildId, volumeValue); // Store the volume setting
      await interaction.reply(`Volume set to ${volume}%`);
    } catch (error) {
      console.error("Error setting volume:", error);
      await interaction.reply("An error occurred while setting the volume.");
    }
  }

  if (interaction.commandName === "stop") {
    const guildPlayer = players.get(interaction.guildId);
    if (guildPlayer) {
      if (guildPlayer.nowPlayingInterval) {
        clearInterval(guildPlayer.nowPlayingInterval);
        guildPlayer.nowPlayingInterval = null;
      }
      guildPlayer.player.stop();
      guildPlayer.connection.destroy();
      players.delete(interaction.guildId);
      await interaction.reply("⏹️ Stopped playing and disconnected from the voice channel.");
    } else {
      await interaction.reply("There is no music currently playing.");
    }
  }

  if (interaction.commandName === "queue") {
    const queue = queues.get(interaction.guildId);
    if (!queue || queue.get().length === 0) {
      return interaction.reply("The queue is empty.");
    }

    const queueList = queue
      .get()
      .map((item, index) => {
        if (index === 0) {
          return `Now Playing: ${item.title}`;
        } else {
          return `${index}. ${item.title}`;
        }
      })
      .join("\n");

    // Check if the queue is longer than 2000 characters (Discord's message limit)
    if (queueList.length > 2000) {
      const shortenedList = queueList.slice(0, 1900) + "\n... (and more)";
      return interaction.reply(`Current Queue:\n${shortenedList}`);
    } else {
      return interaction.reply(`Current Queue:\n${queueList}`);
    }
  }

  if (interaction.commandName === 'skip') {
    const queue = queues.get(interaction.guildId);
    if (!queue || queue.get().length === 0) {
        return interaction.reply('There are no songs to skip.');
    }
    const skipped = queue.skip();
    if (skipped) {
        if (queue.get().length > 0) {
            // Play the next song
            playNext(interaction.guild, queue);
            return interaction.reply(`Skipped: ${skipped.title}\nNow playing: ${queue.get()[0].title}`);
        } else {
            // Stop playing if queue is empty
            const playerInfo = players.get(interaction.guildId);
            if (playerInfo) {
                playerInfo.player.stop();
                playerInfo.connection.destroy();
                players.delete(interaction.guildId);
            }
            return interaction.reply(`Skipped: ${skipped.title}\nThe queue is now empty.`);
        }
    } else {
        return interaction.reply('Failed to skip. The queue might be empty.');
    }
}

  if (interaction.commandName === "remove") {
    const queue = queues.get(interaction.guildId);
    if (!queue || queue.get().length === 0) {
      return interaction.reply("The queue is empty.");
    }
    const range = interaction.options.getString("range");
    let start, end;
    if (range.includes("-")) {
      [start, end] = range.split("-").map(Number);
    } else {
      start = end = Number(range);
    }
    if (
      isNaN(start) ||
      isNaN(end) ||
      start < 1 ||
      end > queue.get().length ||
      start > end
    ) {
      return interaction.reply("Invalid range provided.");
    }
    queue.remove(start, end+1);
    if(start < end){
      return interaction.reply(
        `Removed songs ${start} to ${end} from the queue.`
      );
    }else{
      return interaction.reply(
        `Removed song ${start} from the queue.`
      );
    }
  }

  if (interaction.commandName === "shuffle") {
    const queue = queues.get(interaction.guildId);
    if (!queue || queue.get().length < 2) {
      return interaction.reply("Not enough songs in the queue to shuffle.");
    }
    queue.shuffle();
    return interaction.reply("Queue has been shuffled.");
  }

  if (interaction.commandName === "loop") {
    const queue = queues.get(interaction.guildId);
    if (!queue) {
      return interaction.reply("There is no active queue.");
    }
    const looping = queue.toggleLoop();
    return interaction.reply(
      `Queue looping is now ${looping ? "enabled" : "disabled"}.`
    );
  }

  if (interaction.commandName === "getvolume") {
    const guildId = interaction.guildId;
    const volume = guildVolumes.get(guildId);

    if (volume === undefined) {
      return interaction.reply("Volume is currently set to default (50%)");
    } else {
      const percentage = Math.round(volume * 100);
      return interaction.reply(`Current volume is set to ${percentage}%`);
    }
  }

  if (interaction.commandName === "nowplaying") {
    const queue = queues.get(interaction.guildId);
    const playerInfo = players.get(interaction.guildId);

    if (!queue || !playerInfo || queue.get().length === 0) {
      return interaction.reply({
        content: "Nothing is currently playing.",
        ephemeral: true,
      });
    }

    const current = queue.get()[0];
    const elapsed = Math.floor(playerInfo.player.state.resource.playbackDuration / 1000);
    const { embed, row } = createNowPlayingEmbed(current, elapsed);
    await interaction.reply({ embeds: [embed], components: [row] });
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  if (interaction.isButton()) {
    const playerInfo = players.get(interaction.guildId);
    if (!playerInfo) {
      return interaction.reply({ content: "No active player.", ephemeral: true });
    }

    const player = playerInfo.player;
    switch (interaction.customId) {
      case "pause":
        player.pause();
        return interaction.reply({ content: "⏸️ Playback paused.", ephemeral: true });
        // break;
      case "resume":
        player.unpause();
        return interaction.reply({ content: "▶️ Playback resumed.", ephemeral: true });
        // break;
      case "stop":
        player.stop();
        playerInfo.connection.destroy();
        players.delete(interaction.guildId);
        return interaction.reply({ content: "⏹️ Playback stopped.", ephemeral: true });
        // break;
    }
  }

  switch (interaction.customId) {
    case "pause":
      player.pause();
      await interaction.reply({ content: "⏸️ Paused", ephemeral: true });
      break;
    case "resume":
      player.unpause();
      await interaction.reply({ content: "▶️ Resumed", ephemeral: true });
      break;
    case "stop":
      player.stop();
      queues.delete(interaction.guildId);
      await interaction.reply({ content: "⏹️ Stopped playback", ephemeral: true });
      break;
  }
});

client.login(TOKEN);
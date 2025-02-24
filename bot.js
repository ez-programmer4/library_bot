const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const mongoose = require("mongoose");
require("dotenv").config();
const { User, Book, Reservation } = require("./models");
const crypto = require("crypto");

const app = express();
app.use(express.json());
const port = process.env.PORT || 5000;

// Replace with your bot's API token
const token = process.env.TOKEN;
const bot = new TelegramBot(token);
const librarianChatId = process.env.LIBRARIAN_CHAT_ID.trim();
const validCommands = [
  "/start",
  "/register",
  "/help",
  "/change_language",
  "/select_language",
  "/reserve",
  "/back",
  "/my_reservations",
  "/cancel_reservation",
  "/add_books",
  "/view_reservations",
  "/librarian_add_reservation",
  "/librarian_cancel_reservation",
  "/remove_book",
];

// Database connection
async function connectToDatabase() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("MongoDB connected!");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    setTimeout(connectToDatabase, 5000);
  }
}
connectToDatabase();

// Handle incoming messages
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  console.log(`Received message from ${chatId}: ${msg.text}`);

  try {
    if (msg.text.startsWith("/")) {
      await handleCommand(chatId, msg.text);
    } else {
      await handleUnexpectedMessage(chatId, msg.text);
    }
  } catch (error) {
    console.error("Error processing message:", error);
    await handleError(
      chatId,
      "⚠️ An error occurred while processing your message. Please try again.",
      `Error: ${error.message}`
    );
  }
});

// Handle commands
async function handleCommand(chatId, text) {
  const command = text.split(" ")[0];
  const parameter = text.split(" ")[1];

  if (!validCommands.includes(command)) {
    return bot.sendMessage(
      chatId,
      "❌ Invalid command. Please type /help for the list of available commands."
    );
  }

  switch (command) {
    case "/reserve":
      parameter
        ? await handleReserveCommand(chatId, parameter)
        : await bot.sendMessage(
            chatId,
            "❗️ Please specify an ID to reserve a book. Example: /reserve <ID>"
          );
      break;
    case "/cancel_reservation":
      parameter
        ? await handleCancelReservation(chatId, parameter)
        : await bot.sendMessage(
            chatId,
            "❗️ Please specify an ID to cancel a reservation. Example: /cancel_reservation <ID>"
          );
      break;
    default:
      // Handle other commands if needed
      break;
  }
}

async function handleReserveCommand(chatId, bookId) {
  try {
    console.log(`User ${chatId} is trying to reserve book ID: ${bookId}`);

    const book = await Book.findOne({ id: bookId, available: true });
    if (!book) {
      console.log(`Book with ID ${bookId} not found or not available.`);
      return bot.sendMessage(
        chatId,
        "❌ Invalid book ID or the book is not available."
      );
    }

    const user = await User.findOne({ chatId });
    if (!user) {
      console.log(
        `User with chat ID ${chatId} not found. User needs to register.`
      );
      return bot.sendMessage(
        chatId,
        "🚫 You need to register first using /start."
      );
    }

    // Log user details for debugging
    console.log(`User details: ${JSON.stringify(user)}`);

    // Check for key and iv
    if (!user.key || !user.iv || !user.phoneNumber) {
      console.error(`Missing key, iv, or phoneNumber for user ${chatId}.`);
      return bot.sendMessage(
        chatId,
        "⚠️ Unable to retrieve your details. Please register again."
      );
    }

    // Decrypt the phone number
    const decryptedPhoneNumber = decryptPhoneNumber(
      user.phoneNumber,
      user.key,
      user.iv
    );

    const reservation = new Reservation({
      userId: user._id,
      bookId: book._id,
      pickupTime: "after isha salah",
    });
    await reservation.save();
    console.log(`Reservation saved: ${reservation}`);

    book.available = false; // Mark the book as unavailable
    await book.save();
    console.log(`Book ID ${bookId} marked as unavailable.`);

    // Prepare message with decrypted phone number
    const messageToLibrarian = `📩 New reservation:\n- Book ID: "${book.id}"\n- Title: "${book.title}"\n- Name: ${user.userName}\n- Phone: ${decryptedPhoneNumber}`;
    console.log("Message to Librarian:", messageToLibrarian); // Log the message

    // Notify the librarian without Markdown
    await notifyLibrarian(
      messageToLibrarian,
      { parse_mode: "HTML" } // Using HTML for uniformity, if preferred
    );

    // Confirmation message without formatting
    const confirmationMessage = await bot.sendMessage(
      chatId,
      `✅ Successfully reserved: "${book.title}".\nPickup time: after isha salah.\n📚 To view current reservation, type /my_reservations.`
    );

    const backButton = {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔙 Back to Main Menu",
              callback_data: "back_to_main_menu",
            },
          ],
        ],
      },
    };

    await bot.sendMessage(
      chatId,
      "What would you like to do next?",
      backButton
    );

    return confirmationMessage.message_id;
  } catch (error) {
    console.error("Error reserving book:", error);
    await handleError(
      chatId,
      "⚠️ There was an error processing your reservation. Please try again.",
      `Error saving reservation: ${error.message}`
    );
  }
}
// Handle cancellation of reservation
async function handleCancelReservation(chatId, bookId) {
  try {
    const user = await User.findOne({ chatId });
    if (!user) {
      return bot.sendMessage(
        chatId,
        "🚫 You need to register first using /start."
      );
    }

    const book = await Book.findOne({ id: bookId });
    if (!book) {
      return bot.sendMessage(chatId, "❌ No book found with that ID.");
    }

    const reservation = await Reservation.findOne({
      bookId: book._id,
      userId: user._id,
    }).populate("bookId");

    if (!reservation) {
      return bot.sendMessage(
        chatId,
        "❌ No reservation found with that book ID or it does not belong to you."
      );
    }

    // Mark the book as available and delete the reservation
    book.available = true;
    await book.save();
    await Reservation.findByIdAndDelete(reservation._id);

    // Decrypt the phone number for the notification
    const decryptedPhoneNumber = decryptPhoneNumber(
      user.phoneNumber,
      user.key,
      user.iv
    );

    // Create an inline keyboard for the back button
    const backButton = {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔙 Back to Main Menu",
              callback_data: "back_to_main_menu", // Adjust this to your desired action
            },
          ],
        ],
      },
    };

    await bot.sendMessage(
      chatId,
      `✅ You have successfully canceled the reservation for *"${book.title}"*.`,
      { parse_mode: "Markdown", ...backButton }
    );

    // Notify the librarian with formatted message
    await notifyLibrarian(
      `📩 User has canceled a reservation:\n- Title: "${book.title}"\n- User ID: ${user._id}\n- Name: ${user.userName}\n- Phone: ${decryptedPhoneNumber}`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("Error canceling reservation:", error);
    await handleError(
      chatId,
      "⚠️ An error occurred while canceling your reservation. Please try again.",
      `Error canceling reservation: ${error.message}`
    );
  }
}

async function handleError(chatId, userMessage, logMessage) {
  // Send the user a generic error message
  await bot.sendMessage(chatId, userMessage);

  // Log the detailed error to the console or a logging service
  console.error(logMessage);
}
// Handle the callback query
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const callbackData = query.data;

  // Pass message_id and query_id to handleCallbackQuery
  await handleCallbackQuery(
    chatId,
    callbackData,
    query.message.message_id,
    query.id
  );
});

// Updated handleCallbackQuery function
async function handleCallbackQuery(chatId, callbackData, messageId, queryId) {
  console.log("Received callback data:", callbackData);

  const validLanguages = ["Arabic", "Amharic", "AfaanOromo"];

  // Handle back to language selection
  if (callbackData === "back_to_language") {
    await bot.deleteMessage(chatId, messageId);
    await bot.sendMessage(chatId, "🔄 Returning to language selection...");
    await askLanguageSelection(chatId);
    return;
  }

  // Handle back to main menu
  if (callbackData === "back_to_main_menu") {
    await bot.deleteMessage(chatId, messageId);
    await bot.sendMessage(chatId, "🔙 Returning to the main menu...");
    await askLanguageSelection(chatId); // Ensure it goes to the main menu
    return;
  }

  // Handle back to category selection
  if (callbackData === "back_to_category") {
    await bot.deleteMessage(chatId, messageId);
    await bot.sendMessage(chatId, "🔄 Returning to category selection...");
    const lastSelectedLanguage = userStates[chatId]?.language;
    console.log(userStates);
    console.log(lastSelectedLanguage);
    if (lastSelectedLanguage) {
      await handleLanguageSelection(chatId, lastSelectedLanguage);
    } else {
      await bot.sendMessage(
        chatId,
        "⚠️ Language selection not found. Please select a language first."
      );
    }
    return;
  }

  // Handle Help command
  if (callbackData === "help") {
    await bot.deleteMessage(chatId, messageId);
    const helpMessage = `
    🤖 Library Bot Help
    
    Here are the commands you can use:
    
    📚 /start: to start the bot and register.
   Example: /start
    
    🌐 /select_language: Change your preferred language.
       Example: /change_language
    
    📖 /reserve <book_id>: Reserve a specific book.
       Example: /reserve_book 112
    
    📝 /my_reservations: View your current reservations.
       Example: /my_reservations
    
    ❌ /cancel_reservation <book_id>: Cancel a specific reservation by book id.
       Example: /cancel_reservation 112

    ❓ /help: Get help on using the bot.
      Example: /help
    
    For more questions, feel free to reach out to us via @IrshadComments_bot! 📩
    `;
    await bot.sendMessage(chatId, helpMessage);
    return;
  }

  // Handle Register command
  if (callbackData === "register") {
    await bot.deleteMessage(chatId, messageId);
    await bot.sendMessage(
      chatId,
      "🚀 Please provide your information to register..."
    );
    return;
  }

  // Handle language selection
  if (validLanguages.includes(callbackData)) {
    userStates[chatId] = { language: callbackData };
    await bot.editMessageText(`🌐 You have selected *${callbackData}*.`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
    });
    await handleLanguageSelection(chatId, callbackData);
    return;
  }
  console.log("from", callbackData);
  // If none of the above, handle category selection
  await handleCategorySelection(chatId, callbackData);

  // Acknowledge the callback
  await bot.answerCallbackQuery(queryId);
}
// Handle category selection
async function handleCategorySelection(chatId, selectedCategory) {
  const books = await Book.find({
    category: selectedCategory,
    available: true,
  });

  userStates[chatId] = { ...userStates[chatId], category: selectedCategory };

  if (books.length > 0) {
    const bookList = books
      .map((book) => `🔖 *ID:* *${book.id}* - *"${book.title}"*`)
      .join("\n");
    const inlineButtons = [
      [
        {
          text: "🔙 Back to Category Selection",
          callback_data: "back_to_category",
        },
      ],
    ];

    await bot.sendMessage(
      chatId,
      `📖 *Available books in* *"${selectedCategory}"*:\n\n${bookList}\n\nTo reserve a book, type /reserve <ID>.`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: inlineButtons },
      }
    );
  } else {
    // Notify the user that no books are available
    await bot.sendMessage(
      chatId,
      `⚠️ *No available books in* *"${selectedCategory}"*. Please check back later or select a different category.`,
      {
        parse_mode: "Markdown",
      }
    );
  }
}
async function handleMessage(chatId, msg) {
  // Check if the user is in a registration state
  if (userStates[chatId]) {
    await handleRegistrationSteps(chatId, msg);
  } else {
    // Handle other commands or unexpected messages
    await handleUnexpectedMessage(chatId, msg);
  }
}

async function handleUnexpectedMessage(chatId, message) {
  // Check if message has text property
  if (!message.text) {
    return; // Exit if there's no text
  }

  const messageText = message.text; // Access the message text
  const isCommand =
    messageText.startsWith("/") &&
    validCommands.some((cmd) => messageText.startsWith(cmd));
  const isReserveCommand = messageText.startsWith("/reserve");
  const isCancelReservationCommand = messageText.startsWith(
    "/cancel_reservation"
  );
  const isLanguage = ["Arabic", "Amharic", "AfaanOromo"].includes(messageText);
  const hasValidID = messageText.split(" ").length === 2;

  if (isReserveCommand && !hasValidID) {
    await bot.sendMessage(
      chatId,
      "❗ Please specify an ID to reserve a book. Example: /reserve <ID>"
    );
  } else if (isCancelReservationCommand && !hasValidID) {
    await bot.sendMessage(
      chatId,
      "❗ Please specify an ID to cancel a reservation. Example: /cancel_reservation <ID>"
    );
  } else if (!isCommand && !isLanguage) {
    await bot.sendMessage(
      chatId,
      "❓ I didn't understand that. Please type /help to see available commands."
    );
  }
}

// Add this function to handle text messages
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  handleMessage(chatId, msg); // Call handleMessage instead of handleUnexpectedMessage
});
// Add this function to handle text messages
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  handleMessage(chatId, msg); // Call handleMessage instead of handleUnexpectedMessage
});

// Start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `

          •┈┈••✦📖✦••┈┈••✦📖✦••┈┈•
        اَلسَّلاَمُ عَلَيْكُمْ وَرَحْمَةُ اللهِ وَبَرَكَاتُهُ
        
  🎉 *Welcome to the KJUMJ IRSHAD Library Booking Bot!* 📚

            FEMALE ONLY ‼️
  
  Please choose an option below:
      
                 KJUMJ IRSHAD 1445/46
        •┈┈••✦📖✦••┈┈••✦📖✦••┈┈•
  `;

  const options = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📝 Register", callback_data: "register" },
          { text: "🤔 Help", callback_data: "help" },
        ],
      ],
    },
  };

  bot.sendMessage(chatId, welcomeMessage, {
    parse_mode: "Markdown",
    ...options,
  });
});

const userStates = {};

// Handle button callbacks for Register and Help
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;

  if (query.data === "register") {
    console.log(`User ${chatId} initiated registration.`);

    try {
      const existingUser = await User.findOne({ chatId });
      if (existingUser) {
        console.log(
          `User ${chatId} is already registered as ${existingUser.userName}.`
        );
        await bot.sendMessage(
          chatId,
          `🚫 You are already registered as *${existingUser.userName}*.`,
          { parse_mode: "Markdown" }
        );
        return askLanguageSelection(chatId);
      }

      userStates[chatId] = { step: 1 };
      console.log(`User ${chatId} is at step 1: asking for full name.`);
      await bot.sendMessage(chatId, "📝 Please enter your full name:", {
        parse_mode: "Markdown",
      });
    } catch (error) {
      // await handleError(
      //   chatId,
      //   "⚠️ An error occurred during registration. Please try again.",
      //   `Error during registration initiation: ${error.message}`
      // );
    }
  } else if (query.data === "help") {
    const helpMessage = `
🤖 *Library Bot Help*
Here are the commands you can use:
 📚 */start*: To start the bot and register  
   Example: */start*
 🌐 */select_language*: select your preferred language.  
   Example: */select_language*
 📖 */reserve* <book_id>: Reserve a specific book.  
   Example: */reserve_book 112*
 📝 */my_reservations*: View your current reservations.  
   Example: */my_reservations*
 ❌ */cancel_reservation* <number>: Cancel a specific reservation by its number.  
   Example: */cancel_reservation 1*
 ❓ */help*:  Get help on using the bot.
   Example: */help*
For more questions, feel free to reach out to us via *@IrshadComments_bot*! 📩
`;
    await bot.sendMessage(chatId, helpMessage, { parse_mode: "Markdown" });
  }

  // Acknowledge the callback
  bot.answerCallbackQuery(query.id);
});

const PHONE_REGEX = /^09\d{8}$/; // Matches phone numbers starting with 09 and followed by 8 digits

async function handleRegistrationSteps(chatId, msg) {
  const step = userStates[chatId]?.step;

  if (step === 1) {
    await handleNameStep(chatId, msg.text);
  } else if (step === 2) {
    await handlePhonePrompt(chatId);
  } else if (step === 3) {
    await processPhoneNumber(chatId, msg.text);
  }
}

async function handleNameStep(chatId, userName) {
  userName = userName.trim(); // Trim any leading/trailing spaces

  if (!userName) {
    await bot.sendMessage(
      chatId,
      "❌ Full name cannot be empty. Please try again:"
    );
    return;
  }

  userStates[chatId].userName = userName; // Save the user's full name
  userStates[chatId].step = 2; // Move to the next step

  await bot.sendMessage(chatId, `✅ Welcome, ${userStates[chatId].userName}!`);
}

async function handlePhonePrompt(chatId) {
  await bot.sendMessage(
    chatId,
    "📞 Please enter your phone number (must start with 09 and be 10 digits long):"
  );
  userStates[chatId].step = 3;
}

async function processPhoneNumber(chatId, phoneNumber) {
  console.log(`User ${chatId} provided phone number: ${phoneNumber}`);

  if (!PHONE_REGEX.test(phoneNumber)) {
    await bot.sendMessage(
      chatId,
      "❌ Invalid phone number. Please enter a valid phone number starting with 09 and consisting of 10 digits."
    );
    await handlePhonePrompt(chatId);
    return; // Stop processing if the number is invalid
  }

  // Check for duplicate phone number
  const existingUser = await User.findOne({ phoneNumber });
  if (existingUser) {
    await bot.sendMessage(
      chatId,
      "❌ This phone number is already registered. Please enter a different phone number."
    );
    await handlePhonePrompt(chatId);
    return; // Stop processing if the number is already registered
  }

  try {
    const user = await addUser(
      chatId,
      userStates[chatId].userName,
      phoneNumber
    );
    await notifyLibrarian(
      `🆕 New registration: ${user.userName}, Phone: ${phoneNumber}`
    );
    await bot.sendMessage(
      chatId,
      `✅ Registration successful! Welcome, *${user.userName}*! 🎉`,
      { parse_mode: "Markdown" }
    );
    askLanguageSelection(chatId);
    delete userStates[chatId]; // Clear the registration state
  } catch (error) {
    console.error(`Error during registration saving: ${error.message}`); // Log detailed error
    // await handleError(
    //   chatId,
    //   "⚠️ An error occurred while saving your registration. Please try again.",
    //   `Error during registration saving: ${error.message}`
    // );
  }
}

function encryptPhoneNumber(phoneNumber) {
  const algorithm = "aes-256-cbc";
  const key = crypto.randomBytes(32); // Use a fixed key for real applications
  const iv = crypto.randomBytes(16); // Initialization vector

  let cipher = crypto.createCipheriv(algorithm, Buffer.from(key), iv);
  let encrypted = cipher.update(phoneNumber, "utf-8", "hex");
  encrypted += cipher.final("hex");

  return {
    encryptedPhoneNumber: encrypted,
    key: key.toString("hex"),
    iv: iv.toString("hex"),
  };
}

// Update the addUser function
async function addUser(chatId, userName, phoneNumber) {
  try {
    const { encryptedPhoneNumber, key, iv } = encryptPhoneNumber(phoneNumber);
    const user = new User({
      userName,
      phoneNumber: encryptedPhoneNumber, // Store encrypted phone number
      chatId,
      key, // Ensure key is saved
      iv, // Ensure iv is saved
    });
    await user.save();
    console.log(
      `New user created: ${user.userName}, Phone: [encrypted], Chat ID: ${chatId}`
    );
    return user;
  } catch (error) {
    console.error(`Error adding user: ${error.message}`);
    throw error; // Rethrow to handle in the calling function
  }
}
// Function to decrypt the phone number when needed
function decryptPhoneNumber(encryptedPhoneNumber, key, iv) {
  const algorithm = "aes-256-cbc";
  let decipher = crypto.createDecipheriv(
    algorithm,
    Buffer.from(key, "hex"),
    Buffer.from(iv, "hex")
  );
  let decrypted = decipher.update(encryptedPhoneNumber, "hex", "utf-8");
  decrypted += decipher.final("utf-8");
  return decrypted;
}

// Notify librarian
async function notifyLibrarian(message) {
  await bot.sendMessage(librarianChatId, message);
}

// Ask for language selection
function askLanguageSelection(chatId) {
  bot.sendMessage(chatId, "🌐 Please select a language:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "       🌍 Arabic         ", callback_data: "Arabic" }],
        [{ text: "       🌍 Amharic        ", callback_data: "Amharic" }],
        [{ text: "       🌍 Afaan Oromoo  ", callback_data: "AfaanOromo" }],
      ],
    },
  });
}

async function handleLanguageSelection(chatId, language) {
  userStates[chatId] = { language };
  console.log(userStates);
  const categories = await Book.distinct("category", { language });

  if (categories.length > 0) {
    const inlineButtons = categories.map((cat) => [
      { text: `📚 ${cat}`, callback_data: cat }, // Add a book icon to each category
    ]);

    // Add a back button to return to language selection
    inlineButtons.push([
      {
        text: "🔙 Back to Language Selection",
        callback_data: "back_to_language",
      },
    ]);

    await bot.sendMessage(chatId, `📚 Please choose a *category*:`, {
      reply_markup: {
        inline_keyboard: inlineButtons,
      },
      parse_mode: "Markdown", // Specify the parse mode
    });
  }
}

// Handle the back button press

async function isCategory(category) {
  const categories = await Book.distinct("category");
  return categories.includes(category);
}

async function isCategory(category) {
  const categories = await Book.distinct("category");
  return categories.includes(category);
}
bot.onText(/\/select_language/, (msg) => {
  const chatId = msg.chat.id;
  askLanguageSelection(chatId);
});

// Reservation logic

bot.onText(/\/back/, (msg) => {
  const chatId = msg.chat.id;
  askLanguageSelection(chatId); // Call the function to ask for language selection
});
bot.onText(/\/add_books (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;

  // Check if the user is a librarian
  if (!isLibrarian(chatId)) {
    return bot.sendMessage(
      chatId,
      "🚫 You do not have permission to add books."
    );
  }

  const entries = match[1].split(";").map((entry) => entry.trim());

  for (const entry of entries) {
    const parts = entry.match(/^(\d+) (.+) "(.+)" "(.+)"$/); // Updated regex to allow any language
    if (!parts) {
      await bot.sendMessage(
        chatId,
        `❌ Invalid format for entry: *"${entry}".*`,
        { parse_mode: "Markdown" }
      );
      continue;
    }

    const id = parseInt(parts[1], 10);
    const language = parts[2].trim();
    const category = parts[3].trim();
    const title = parts[4].trim();

    const existingBook = await Book.findOne({ id });
    if (existingBook) {
      await bot.sendMessage(
        chatId,
        `🚫 A book with ID *${id}* already exists.`
      );
      continue;
    }

    const newBook = new Book({
      id,
      title,
      available: true,
      language,
      category,
    });
    await newBook.save();
    await bot.sendMessage(chatId, `✅ Book *"${title}"* added successfully.`, {
      parse_mode: "Markdown",
    });
  }
});
bot.onText(/\/my_reservations/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await User.findOne({ chatId });

  if (!user) {
    return bot.sendMessage(
      chatId,
      "🚫 You need to register first using /start."
    );
  }

  const userReservations = await Reservation.find({
    userId: user._id,
  }).populate("bookId");

  if (userReservations.length === 0) {
    return bot.sendMessage(chatId, "📭 You currently have no reservations.");
  }

  const escapeMarkdown = (text) => {
    return text
      .replace(/_/g, "\\_") // Escape underscores
      .replace(/\*/g, "\\*") // Escape asterisks
      .replace(/~/g, "\\~") // Escape tildes
      .replace(/`/g, "\\`") // Escape backticks
      .replace(/>/g, "\\>") // Escape greater-than
      .replace(/#/g, "\\#") // Escape hashtags
      .replace(/-/g, "\\-") // Escape hyphens
      .replace(/\+/g, "\\+") // Escape pluses
      .replace(/=/g, "\\=") // Escape equals
      .replace(/!/g, "\\!"); // Escape exclamation marks
  };

  const reservationList = userReservations
    .map((res) => {
      const title = escapeMarkdown(res.bookId.title);
      const bookId = res.bookId.id;
      return `📚 Book ID: ${bookId}\n 📄 Title: "${title}"\n ⌚ Pickup: ${res.pickupTime}\n`;
    })
    .join("\n");

  const message = `✨ Your Reservations: ✨\n\n${reservationList}\n\nIf you wish to cancel a reservation, simply type /cancel\_reservation <book_id>.`;

  // Escape the entire message
  const escapedMessage = escapeMarkdown(message);

  // Send message in chunks if necessary
  await sendMessageInChunks(chatId, escapedMessage);

  // // Send message in chunks if necessary
  // await sendMessageInChunks(chatId, message);
});
// Helper function to send messages in chunks if they are too long
async function sendMessageInChunks(chatId, message) {
  const maxLength = 4096; // Telegram message character limit
  if (message.length <= maxLength) {
    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } else {
    // Split message into chunks
    const chunks = [];
    let currentChunk = "";

    const messages = message.split("\n"); // Split by line for better chunking
    for (const line of messages) {
      if ((currentChunk + line).length <= maxLength) {
        currentChunk += line + "\n";
      } else {
        chunks.push(currentChunk);
        currentChunk = line + "\n"; // Start a new chunk
      }
    }
    // Push the last chunk if it has content
    if (currentChunk) {
      chunks.push(currentChunk);
    }

    // Send each chunk as a separate message
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    }
  }
}

// Function to send messages in chunks
async function sendMessageInChunks(chatId, message) {
  const MAX_MESSAGE_LENGTH = 4096; // Telegram message character limit

  if (message.length > MAX_MESSAGE_LENGTH) {
    for (let i = 0; i < message.length; i += MAX_MESSAGE_LENGTH) {
      const msgPart = message.slice(i, i + MAX_MESSAGE_LENGTH);
      await bot.sendMessage(chatId, msgPart, { parse_mode: "Markdown" });
    }
  } else {
    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  }
}

bot.onText(/\/view_reservations/, async (msg) => {
  const chatId = msg.chat.id;

  // Check if the user is a librarian
  if (!isLibrarian(chatId)) {
    return bot.sendMessage(
      chatId,
      "You do not have permission to use this command."
    );
  }

  // Fetch reservations from the database
  const reservations = await Reservation.find().populate("userId bookId");

  // Handle no reservations
  if (reservations.length === 0) {
    return bot.sendMessage(chatId, "📅 There are no reservations.");
  }

  // Format the reservation list
  const reservationList = reservations.map((res) => {
    const userName = res.userId ? res.userId.userName : "Unknown User";
    return `🔖 Book ID: *${res.bookId.id}*  → Book: *"${res.bookId.title}"* → Pickup Time: *${res.pickupTime}*`;
  });

  // Debug log
  console.log("Reservation List:", reservationList);

  // Function to send messages in chunks
  const sendMessageInChunks = async (chatId, messages) => {
    const maxLength = 4096; // Telegram's max length per message

    let chunk = "";
    for (const message of messages) {
      if (chunk.length + message.length > maxLength) {
        if (chunk.length > 0) {
          await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
        }
        chunk = message + "\n"; // Start a new chunk
      } else {
        chunk += message + "\n";
      }
    }

    // Send any remaining chunk
    if (chunk.length > 0) {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    }
  };

  // Prepare the message header
  const header = `📚 Current Reservations:\n\n`;
  const fullMessage = [header, ...reservationList];

  // Send the list of reservations in chunks
  await sendMessageInChunks(chatId, fullMessage);
});
bot.onText(
  /\/librarian_add_reservation (\S+) (\d+) ?(.*)?/,
  async (msg, match) => {
    const chatId = msg.chat.id;

    // Check if the user is a librarian
    if (!isLibrarian(chatId)) {
      return bot.sendMessage(
        chatId,
        "🚫 You do not have permission to use this command."
      );
    }

    const userName = match[1]; // User name
    const bookId = match[2]; // Book ID
    const pickupTime = match[3] || "after isha salah"; // Optional pickup time

    // Find the book by ID
    const book = await Book.findOne({ id: bookId });
    if (!book || !book.available) {
      return bot.sendMessage(
        chatId,
        `❌ Sorry, the book with ID *${bookId}* is not available.`,
        { parse_mode: "Markdown" }
      );
    }

    // Create the reservation without checking for user registration
    const reservation = new Reservation({
      userName, // Store the username directly
      bookId: book._id,
      pickupTime,
    });

    await reservation.save();
    book.available = false; // Mark the book as unavailable
    await book.save();

    await notifyLibrarian(
      `🆕 New manual reservation for ${userName} for "${book.title}".`,
      { parse_mode: "Markdown" }
    );
    bot.sendMessage(
      chatId,
      `✅ Successfully added reservation for *${userName}* for *"${book.title}"*.`,
      { parse_mode: "Markdown" }
    );
  }
);

bot.onText(/\/librarian_cancel_reservation (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const bookId = match[1]; // This is the numeric ID of the book provided by the user

  if (!isLibrarian(chatId)) {
    return bot.sendMessage(
      chatId,
      "🚫 You do not have permission to use this command."
    );
  }

  console.log(`Received book ID: ${bookId}`);

  // Find the book by its numeric ID
  const book = await Book.findOne({ id: bookId });
  if (!book) {
    return bot.sendMessage(
      chatId,
      "❌ No book found with the given ID. Please check and try again."
    );
  }

  // Find the reservation using the book's ObjectId
  const reservation = await Reservation.findOne({ bookId: book._id }).populate(
    "userId"
  );
  if (!reservation) {
    return bot.sendMessage(
      chatId,
      "❌ No reservation found for the given book ID. Please check and try again."
    );
  }

  // Mark the book as available again
  book.available = true; // Mark the book as available again
  await book.save();

  // Delete the reservation
  await Reservation.findByIdAndDelete(reservation._id);

  // Ensure to correctly access the title of the book
  bot.sendMessage(
    chatId,
    `✅ Reservation for *"${book.title}"* has been successfully canceled.`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/change_language/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "🌐 Please select a language:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Arabic", callback_data: "Arabic" }],
        [{ text: "Amharic", callback_data: "Amharic" }],
        [{ text: "AfaanOromo", callback_data: "AfaanOromo" }],
      ],
    },
  });
});

// Handle language selection
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  if (["Arabic", "Amharic", "AfaanOromo"].includes(msg.text)) {
    // Assuming you have a user object to save the language preference
    const user = await User.findOne({ chatId });
    if (user) {
      user.language = msg.text; // Save the selected language
      await user.save();
      bot.sendMessage(chatId, `✅ Language changed to *${msg.text}*.`, {
        parse_mode: "Markdown",
      });
    }
  }
});

bot.onText(/\/remove_book (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;

  // Debugging: Log the incoming message
  console.log(`Received message from ${chatId}: ${msg.text}`);

  // Log the match array
  console.log(`Match array: ${JSON.stringify(match)}`);

  // Check if the user is a librarian
  if (!isLibrarian(chatId)) {
    console.log(`User ${chatId} is not a librarian.`);
    return bot.sendMessage(
      chatId,
      "🚫 You do not have permission to remove books."
    );
  }

  // Check if match array is valid
  if (!match || match.length < 2) {
    console.log(`Invalid command syntax: ${msg.text}`);
    return bot.sendMessage(
      chatId,
      "❌ Invalid command syntax. Please use: /remove_book <id>."
    );
  }

  const id = parseInt(match[1], 10);

  // Debugging: Log the parameters
  console.log(`Attempting to remove book with ID: ${id}`);

  // Attempt to find and remove the book by ID
  const book = await Book.findOneAndDelete({ id });
  if (!book) {
    console.log(`No book found with ID ${id}.`);
    return bot.sendMessage(chatId, `❌ No book found with ID *${id}*.`, {
      parse_mode: "Markdown",
    });
  }

  console.log(`Book with ID ${id} has been removed.`);
  bot.sendMessage(
    chatId,
    `✅ Book with ID *${id}* has been removed successfully.`,
    { parse_mode: "Markdown" }
  );
});

// Check if the user is a librarian
const isLibrarian = (chatId) => {
  return chatId == librarianChatId; // Compare with the librarian's chat ID
};

// Librarian can cancel a reservation
bot.onText(/\/librarian_cancel_reservation (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const bookId = match[1]; // This is the numeric ID of the book provided by the user

  if (!isLibrarian(chatId)) {
    return bot.sendMessage(
      chatId,
      "🚫 You do not have permission to use this command."
    );
  }

  // Find the book by its numeric ID
  const book = await Book.findOne({ id: bookId });
  if (!book) {
    return bot.sendMessage(
      chatId,
      "❌ No book found with the given ID. Please check and try again."
    );
  }

  // Find the reservation by book ID using the book's ObjectId
  const reservation = await Reservation.findOne({ bookId: book._id }).populate(
    "userId"
  );
  if (!reservation) {
    return bot.sendMessage(
      chatId,
      "❌ No reservation found for the given book ID. Please check and try again."
    );
  }

  // Mark the book as available again
  book.available = true;
  await book.save();

  // Delete the reservation
  await Reservation.findByIdAndDelete(reservation._id);
  bot.sendMessage(
    chatId,
    `✅ Reservation for *"${reservation.bookId.title}"* has been successfully canceled.`,
    { parse_mode: "Markdown" }
  );
});
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;

  const helpMessage = `
  🤖 Library Bot Help
  
  Here are the commands you can use:
  
  📚 /start: to start the bot and register.
 Example: /start
  
  🌐 /select_language: Change your preferred language.
     Example: /change_language
  
  📖 /reserve <book_id>: Reserve a specific book.
     Example: /reserve_book 112
  
  📝 /my_reservations: View your current reservations.
     Example: /my_reservations
  
  ❌ /cancel_reservation <book_id>: Cancel a specific reservation by book id.
     Example: /cancel_reservation 112

  ❓ /help: Get help on using the bot.
    Example: /help
  
  For more questions, feel free to reach out to us via @IrshadComments_bot! 📩
  `;

  bot.sendMessage(chatId, helpMessage);
});
// Start the Express server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Set the webhook URL
const setWebhook = async () => {
  const url = `https://library-bot-edhs.onrender.com/webhook`;
  await bot.setWebHook(url);
};

app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Set webhook on startup
setWebhook().catch(console.error);

// Error handling
bot.on("polling_error", (error) => {
  console.error("Polling error:", error);
});

bot.on("error", (error) => {
  console.error("Error occurred:", error);
});

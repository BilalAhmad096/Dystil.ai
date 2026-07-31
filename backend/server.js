const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();

app.use(express.json());

app.use(cors({
    origin: process.env.FRONTEND_URL
}));

app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: {
        success: false,
        message: "Too many requests. Please try again later."
    }
}));

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

app.post("/api/submit-form", async function(req, res) {
    try {
        const data = req.body;

        const fullName = data.fullName || "";
        const email = data.email || "";
        const formType = data.formType || "Website Form";

        if (!fullName || !email) {
            return res.status(400).json({
                success: false,
                message: "Full name and email are required."
            });
        }

        let submittedDetails = "";

        Object.keys(data).forEach(function(key) {
            submittedDetails += `
                <tr>
                    <td style="padding:8px;border:1px solid #ddd;"><strong>${key}</strong></td>
                    <td style="padding:8px;border:1px solid #ddd;">${data[key] || "-"}</td>
                </tr>
            `;
        });

        await transporter.sendMail({
            from: `"Dystil Website" <${process.env.FROM_EMAIL}>`,
            to: process.env.ADMIN_EMAIL,
            subject: `New ${formType} Submission - ${fullName}`,
            html: `
                <h2>New Form Submission</h2>
                <p>You received a new submission from the Dystil website.</p>

                <table style="border-collapse:collapse;width:100%;">
                    ${submittedDetails}
                </table>
            `
        });

        await transporter.sendMail({
            from: `"Dystil Students" <${process.env.FROM_EMAIL}>`,
            to: email,
            subject: "Thank you for contacting Dystil Students",
            html: `
                <h2>Thank you, ${fullName}!</h2>

                <p>
                    We have received your details for <strong>${formType}</strong>.
                    Our team will review your submission and contact you shortly.
                </p>

                <p>
                    If you registered for the free taster session or next intake,
                    we will share the next steps with you soon.
                </p>

                <br>

                <p>Regards,</p>
                <p><strong>Dystil Students Team</strong></p>
            `
        });

        return res.json({
            success: true,
            message: "Form submitted successfully."
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Something went wrong. Please try again."
        });
    }
});

app.listen(process.env.PORT, function() {
    console.log(`Server running on port ${process.env.PORT}`);
});
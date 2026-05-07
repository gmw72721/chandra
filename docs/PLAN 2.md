I want to build a platform to help teachers guide AI usage for their students so that students cannot just get answers from AI. The goal is to help students use AI to learn effectively. The teachers specify behaviors (such as don't give the answer, walk through the problem with the student, refer the student to example X in the textbook, etc). The teacher or student should be able to select a model to use. The instructions from the teacher are added to the context of the student's prompt, but the teacher should have the option to hide the instructions from the student. The teacher should be able to upload pdfs of lecture notes, textbooks, examples, etc and the AI should be able to retrieve information to help the student with a problem.

The interface for a student should be similar to that of any chat model, but it should support latex rendering.

The teacher should be able to have a dashboard that allows them to control the AI behavior on problems. Conversations should also be recorded and made available to the teacher so that the teacher can understand what is difficult for the student. The teacher should be able to generate an AI summary of problems students are facing.

Start building this as a nice github repository.
We can change things as we move forward.




Here is the workflow for the website

Welcome Page
Sign up / login page

If the user logs in as a teacher the dash should show a list of existing classes and the option to create a class.

The dashboard should also have a student view option that opens the chat so the teacher can experience what it is like for students

To create a class the teacher needs to be able to add people to the roster, set AI behavior settings, and upload relevant material.

Once created the class should appear in the dashboard and the teacher should be able to click on it and edit roster, AI settings, materials, etc.

When the student logs in, they should go straight to the chat.
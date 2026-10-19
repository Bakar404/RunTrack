// RunTrack site configuration.
//
// RunTrack runs in guest-only mode by default: plans and runs are saved in
// this browser, the sign-in panel is hidden and the app never contacts
// Firebase.
//
// Optional accounts use Firebase Authentication (Email/Password) and Cloud
// Firestore. To turn them on, create your own Firebase project (see the
// README) and replace `null` with its web app config:
//
//   firebase: {
//     apiKey:            '...',
//     authDomain:        '<project-id>.firebaseapp.com',
//     projectId:         '<project-id>',
//     storageBucket:     '<project-id>.firebasestorage.app',
//     messagingSenderId: '...',
//     appId:             '...'
//   }
//
// These values are public client identifiers, not secrets: firestore.rules
// decides who can read and write data.
window.RUNTRACK_CONFIG = {
  firebase: null
};

const express = require('express');
const app = express();
const pgp = require('pg-promise')();
const bodyParser = require('body-parser');
const session = require('express-session');
const url = require('url');

// db config
const dbConfig = {
  host: 'db',
  port: 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
};

const db = pgp(dbConfig);

// db test
db.connect()
  .then(obj => {
    // Can check the server version here (pg-promise v10.1.0+):
    console.log('Database connection successful');
    obj.done(); // success, release the connection;
  })
  .catch(error => {
    console.log('ERROR:', error.message || error);
  });

// set the view engine to ejs
app.set('view engine', 'ejs');
app.use(bodyParser.json());

// set session
app.use(
  session({
    secret: 'XASDASDA',
    saveUninitialized: true,
    resave: true,
  })
);

app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);

app.get('/login', (req, res) => {
  res.render('pages/login');
});

// Login submission
app.post('/login', (req, res) => {
  const email = req.body.email;
  const username = req.body.username;
  const query = 'select * from students where students.email = $1';
  const values = [email];

  // get the student_id based on the emailid
  db.one(query, values)
    .then(data => {
      req.session.student_id = data.student_id;
      req.session.save();
      res.redirect(
        url.format({
          pathname: '/',
          query: {
            username: username,
            first_name: data.first_name,
            last_name: data.last_name,
            email: data.email,
            year: data.year,
            major: data.major,
            degree: data.degree,
          },
        })
      );
    })
    .catch(err => {
      console.log(err);
      res.redirect('/login');
    });
});

// Authentication middleware.
const auth = (req, res, next) => {
  if (!req.session.student_id) {
    return res.redirect('/login');
  }
  next();
};

app.use(auth);

app.get('/', (req, res) => {
  res.render('pages/home', {
    username: req.query.username,
    first_name: req.query.first_name,
    last_name: req.query.last_name,
    email: req.query.email,
    year: req.query.year,
    major: req.query.major,
    degree: req.query.degree,
  });
});

app.get('/courses', (req, res) => {
  const taken = req.query.taken
  // Query to list all the courses taken by a student
  const student_courses = `
    SELECT DISTINCT
      courses.course_id,
      courses.course_name,
      courses.credit_hours,
      students.student_id = $1 AS "taken"
    FROM
      courses
      JOIN student_courses ON courses.course_id = student_courses.course_id
      JOIN students ON student_courses.student_id = students.student_id
    WHERE students.student_id = $1
    ORDER BY courses.course_id ASC;`;
  
    // Query to list all the available courses 
    const all_courses = `
    SELECT 
      courses.course_id,
      courses.course_name,
      courses.credit_hours,
      CASE 
      WHEN
      courses.course_id IN (
        SELECT student_courses.course_id
        FROM student_courses
        WHERE student_courses.student_id = $1
      ) THEN TRUE
      ELSE FALSE
      END
      AS "taken"
    FROM 
      courses
    ORDER BY courses.course_id ASC;
    `;
  
  db.any(taken ? student_courses : all_courses, [req.session.student_id])
    .then(courses => {
      res.render('pages/courses', {
        courses,
        action: req.query.taken ? 'delete' : 'add',
      });
    })
    .catch(err => {
      res.render('pages/courses', {
        courses: [],
        error: true,
        message: err.message,
      });
    });
});

app.post('/courses/add', (req, res) => {
  const course_id = parseInt(req.body.course_id);
  db.tx(async t => {
    // This transaction will continue iff the student has satisfied all the
    // required prerequisites.
    const {num_prerequisites} = await t.one(
      `SELECT
        num_prerequisites
       FROM
        course_prerequisite_count
       WHERE
        course_id = $1`,
      [course_id]
    );

    if (num_prerequisites > 0) {
      // This returns [] if the student has not taken any prerequisites for
      // the course.
      const [row] = await t.any(
        `SELECT
              num_prerequisites_satisfied
            FROM
              student_prerequisite_count
            WHERE
              course_id = $1
              AND student_id = $2`,
        [course_id, req.session.student_id]
      );

      if (!row || row.num_prerequisites_satisfied < num_prerequisites) {
        throw new Error(`Prerequisites not satisfied for course ${course_id}`);
      }
    }

    // There are either no prerequisites, or all have been taken.
    await t.none(
      'INSERT INTO student_courses(course_id, student_id) VALUES ($1, $2);',
      [course_id, req.session.student_id]
    );
    // TODO(corypaik): Update with query from /courses.
    return t.any('SELECT * FROM courses;');
  })
    .then(courses => {
      console.info(courses);
      res.render('pages/courses', {
        courses,
        message: `Successfully added course ${req.body.course_id}`,
      });
    })
    .catch(err => {
      res.render('pages/courses', {
        courses: [],
        error: true,
        message: err.message,
      });
    });
});

app.post('/courses/delete', (req, res) => {
  db.task('delete-course', task => {
    return task.batch([
      task.none(
        `DELETE FROM
            student_courses
          WHERE
            student_id = $1
            AND course_id = '$2';`,
        [req.session.student_id, parseInt(req.body.course_id)]
      ),
      // TODO(corypaik): Update with query from /courses.
      task.any('SELECT * FROM courses;'),
    ]);
  })
    .then(([, courses]) => {
      console.info(courses);
      res.render('pages/courses', {
        courses,
        message: `Successfully removed course ${req.body.course_id}`,
      });
    })
    .catch(err => {
      res.render('pages/courses', {
        courses: [],
        error: true,
        message: err.message,
      });
    });
});

app.listen(3000);
console.log('Server is listening on port 3000');
